const fs = require('fs');

function parseAndSummarize(jsonFilePath) {
  try {
    const fileContent = fs.readFileSync(jsonFilePath, 'utf8');
    
    // Check if the file looks like it might be JSON (starts with [ or {)
    if (!fileContent.trim().startsWith('[') && !fileContent.trim().startsWith('{')) {
        console.error(`Error: The file '${jsonFilePath}' does not appear to be a JSON file. Please provide a 'commands-*.json' file instead of a plain-text log.`);
        return;
    }
    
    const data = JSON.parse(fileContent);
    
    let hierarchy = null;
    for (const entry of data) {
        if (entry.metadata?.error?.hierarchyRoot) {
            hierarchy = entry.metadata.error.hierarchyRoot;
            break;
        }
    }
    
    if (!hierarchy) {
      console.log("No hierarchy data found in log.");
      return;
    }
    
    const labels = [];
    walk(hierarchy, labels);
    
    console.log("=== Final App State Summary (Maestro-Ready) ===");
    labels.forEach(l => {
        const click = l.clickable ? "👆" : "";
        const focus = l.focused ? "🎯" : "";
        // Structured format aligned with semantics.ts for deterministic selectors
        console.log(`${click}${focus} [${l.type}] '${l.label}' — ${l.bounds}`);
    });
  } catch (e) {
    console.error("Error parsing log:", e);
  }
}

function walk(node, labels) {
  if (!node || typeof node !== "object") return;
  const attrs = node.attributes || {};
  
  if (attrs) {
    let label = "";
    let type = "";
    
    // Explicitly prioritize and identify the source attribute
    if (attrs.accessibilityText) {
      label = attrs.accessibilityText;
      type = "accessibilityText";
    } else if (attrs['resource-id']) {
      label = attrs['resource-id'];
      type = "resource-id";
    }
    
    const clickable = attrs.clickable === "true";
    const bounds = attrs.bounds || "";
    const focused = attrs.focused === "true";

    if (label) {
      labels.push({ label, type, clickable, bounds, focused });
    }
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, labels);
  }
}

parseAndSummarize(process.argv[2]);
