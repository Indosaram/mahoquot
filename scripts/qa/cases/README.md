# Case Modules Interface

Each case module in this directory (`cases/<name>.mjs`) must export:

```javascript
export async function runCase(variant, evidencePath, context) {
  // context: { binary, buildCommand, ports, evidenceBase, runId, getSourceClosure, createReceipt }
  // Returns the constructed receipt object
}
```
