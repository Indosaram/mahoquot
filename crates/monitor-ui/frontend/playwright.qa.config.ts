import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /primitive-showcase\.spec\.ts/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4188",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "bun -e \"import{createServer}from'node:http';import{readFile}from'node:fs/promises';import{resolve}from'node:path';const p=resolve(process.cwd(),'.tmp/monitor-ui-qa/qa.html');const artifact=await readFile(p,'utf8');createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(artifact);}).listen(4188,'127.0.0.1',()=>console.log('qa-server-ready'));\"",
    url: "http://127.0.0.1:4188/qa.html",
    reuseExistingServer: false,
  },
});
