# VM Service (Raw WebSocket Access)

The extension tracks the VM Service URL automatically when `flutter_run` starts. For queries beyond `flutter_inspect_tree`, use a node script:

```javascript
const WebSocket = require("ws");

// Replace with actual URL from flutter_run output
const url = "ws://127.0.0.1:36319/:ws";

const ws = new WebSocket(url);
ws.on("open", () => {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "getVM" }));
});
ws.on("message", (data) => {
  const resp = JSON.parse(data.toString());
  if (resp.id === "1") {
    const isolateId = resp.result.isolates[0].id;
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "2",
        method: "ext.flutter.debugDumpFocusTree",
        params: { isolateId },
      }),
    );
  } else if (resp.id === "2") {
    console.log(resp.result.data || JSON.stringify(resp.result));
    ws.close();
    process.exit(0);
  }
});
```
