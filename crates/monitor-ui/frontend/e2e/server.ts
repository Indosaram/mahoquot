import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

const artifact = await readFile(resolve(process.cwd(), "../ui/index.html"), "utf8");

createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1:4173").pathname;
  if (path === "/management.html" || path === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(artifact);
    return;
  }
  response.writeHead(404);
  response.end("not found");
}).listen(4173, "127.0.0.1");

console.log("mahoquot-e2e-ready");
