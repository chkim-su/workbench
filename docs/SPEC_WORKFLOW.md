# SPEC: Workflow

Workflow is a wrapper feature: users can “just use workflow” without adopting a controlled process.

## Workflow definition (v1)

```jsonc
{
  "version": 1,
  "id": "example",
  "name": "optional",
  "steps": [
    { "id": "s1", "kind": "note", "note": "…" },
    { "id": "s2", "kind": "tool", "tool": "workbench.registry.scan", "input": { "timeoutMs": 5000 } }
  ]
}
```

## Workflow status (v1)

Stored under `.workbench/workflows/<id>/status.json`.

States: `uploaded` → `updated`.

