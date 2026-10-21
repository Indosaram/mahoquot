import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFixture } from '../cliproxy-parity.mjs';
import { validateRounds, balancedOrder } from '../../../mahoquot-proxy/tools/bench/scripts/fair-translation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
async function child(argv, cwd, env) {
  const proc = Bun.spawn(argv, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  let timer;
  try {
    const code = await Promise.race([proc.exited, new Promise((_, reject) => { timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('bench QA timeout')); }, 600000); })]);
    const [stdout, stderr] = await output;
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); await proc.exited; }
}
function fixture(protocol, variant) {
  const usage = { input_tokens: 16, output_tokens: variant === 'wrongusage' ? 99 : 1 };
  if (protocol === 'responses') return [
    'data: {"type":"response.created"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"x"}\n\n',
    ...(variant === 'droppedterminal' ? [] : [`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ content: [{ text: 'x' }] }], usage } })}\n\n`]),
  ].join('');
  if (protocol === 'anthropic') return `data: {"type":"message_start","message":{"usage":{"input_tokens":16}}}\n\ndata: {"type":"content_block_delta","delta":{"text":"x"}}\n\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: usage.output_tokens } })}\n\n${variant === 'droppedterminal' ? '' : 'data: {"type":"message_stop"}\n\n'}`;
  if (protocol === 'gemini') return `data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}\n\n${variant === 'droppedterminal' ? '' : 'data: {"candidates":[{"finishReason":"STOP"}]}\n\n'}data: ${JSON.stringify({ usageMetadata: { promptTokenCount:16, candidatesTokenCount:usage.output_tokens } })}\n\n`;
  return `data: {"choices":[{"delta":{"content":"x"}}]}\n\n${variant === 'droppedterminal' ? '' : `data: ${JSON.stringify({ choices:[{ delta:{}, finish_reason:'stop' }], usage:{ prompt_tokens:16, completion_tokens:usage.output_tokens } })}\n\ndata: [DONE]\n\n`}`;
}
export async function runCase(variant, evidencePath, context) {
  if (!['happy', 'failure'].includes(variant)) throw new Error('unknown variant');
  const base = await runFixture('happy', `${evidencePath}.fixture.json`);
  const target = join(dirname(context.binary), '..');
  const built = await child(['cargo', 'build', '-p', 'bench', '--bin', 'bench'], join(root, 'mahoquot-proxy'), { ...process.env, CARGO_TARGET_DIR: target, CARGO_NET_OFFLINE: 'true' });
  if (built.code !== 0) throw new Error(built.stderr);
  const bench = join(dirname(context.binary), 'bench');
  const captures = [], reports = {}, events = [...base.events];
  let current = { protocol:'openai', variant:'happy' };
  const server = Bun.serve({ hostname:'127.0.0.1', port:18841, async fetch(request) {
    const body = await request.text();
    captures.push({ method:request.method, url:request.url, body, body_bytes_base64:Buffer.from(body).toString('base64'), body_sha256:createHash('sha256').update(body).digest('hex') });
    return new Response(fixture(current.protocol, current.variant), { headers:{ 'content-type':'text/event-stream' } });
  } });
  await mkdir(dirname(evidencePath), { recursive:true });
  let missingRejected = false, wrongRejected = false, droppedRejected = false;
  let pairedComplete = false, terminalUsageCorrect = false;
  try {
    for (const protocol of ['openai','responses','anthropic','gemini']) {
      for (let round = 1; round <= 2; round++) for (const tier of balancedOrder(round)) {
        current = { protocol, variant:'happy' };
        const output = `${evidencePath}.${protocol}-${round}-${tier}.json`;
        const run = await child([bench,'run','--url','http://127.0.0.1:18841/v1/chat/completions','--total','1','--concurrency','1','--body-json',JSON.stringify({ model:'fixture', bench_expect:{ text:'x', input_tokens:16, output_tokens:1 } }),'--out',output], root, { ...process.env, BENCH_SESSION_MODE:'none' });
        if (run.code !== 0) throw new Error(run.stderr);
        reports[`${protocol}/${round}/${tier}`] = JSON.parse(await readFile(output,'utf8'));
        events.push({ type:'bench-sample', protocol, round, tier, exit:run.code });
      }
    }
    const validated = validateRounds(reports, 2, ['openai','responses','anthropic','gemini']);
    pairedComplete = Boolean(
      validated &&
      validated.rounds === 2 &&
      ['openai','responses','anthropic','gemini'].every(protocol =>
        [1, 2].every(round =>
          ['B', 'C'].every(tier => {
            const r = reports[`${protocol}/${round}/${tier}`];
            return r && r.correctness_passed && r.failed === 0 && r.successful === r.total;
          })
        )
      )
    );
    terminalUsageCorrect = Object.values(reports).length === 4 * 2 * 2 && Object.values(reports).every(r =>
      r.correctness_passed &&
      r.semantic_samples === r.total &&
      r.total > 0 &&
      r.failed === 0
    );
    if (variant === 'failure') {
      const incomplete = { ...reports }; delete incomplete['openai/2/C'];
      try { validateRounds(incomplete,2,['openai']); } catch (error) { missingRejected = error.message.includes('missing round'); }
      for (const failure of ['wrongusage','droppedterminal']) {
        current = { protocol:'responses', variant:failure };
        const output = `${evidencePath}.${failure}.json`;
        const run = await child([bench,'run','--url','http://127.0.0.1:18841/v1/chat/completions','--total','1','--concurrency','1','--body-json',JSON.stringify({ bench_expect:{ text:'x', input_tokens:16, output_tokens:1 } }),'--out',output], root, { ...process.env, BENCH_SESSION_MODE:'none' });
        const report = JSON.parse(await readFile(output,'utf8'));
        const rejected = run.code !== 0 && !report.correctness_passed && report.failed === 1 && !('ttft_ms' in report) && !('rps' in report);
        if (failure === 'wrongusage') wrongRejected = rejected; else droppedRejected = rejected;
        events.push({ type:'bench-rejection', failure, exit:run.code, errors:report.errors });
      }
      if (!missingRejected || !wrongRejected || !droppedRejected) throw new Error('negative bench gate did not reject');
    }
  } finally { server.stop(true); }
  const probe = Bun.listen({ hostname:'127.0.0.1',port:18841,socket:{data(){}} }); probe.stop(true);
  const assertions = variant === 'happy'
    ? [
        { id: 'paired-rounds-complete', expected: true, actual: pairedComplete, pass: pairedComplete === true },
        { id: 'terminal-usage-correct', expected: true, actual: terminalUsageCorrect, pass: terminalUsageCorrect === true },
      ]
    : [{id:'missing-round-fails',expected:true,actual:missingRejected,pass:missingRejected},{id:'wrong-usage-fails',expected:true,actual:wrongRejected && droppedRejected,pass:wrongRejected && droppedRejected}];
  const receipt = context.createReceipt({ caseName:'bench-core',variant,assertions,requiredAssertionIds:assertions.map(a=>a.id),events,wireRequests:[...base.wire_capture.gateway_requests,...captures],provenance:{...base.provenance,bench_sha256:createHash('sha256').update(await readFile(bench)).digest('hex')},teardown:base.teardown });
  await writeFile(evidencePath,JSON.stringify(receipt,null,2));
  return receipt;
}
