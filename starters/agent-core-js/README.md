# Agent Core JavaScript starter

A dependency-free, editable first integration for the local synthetic sandbox.
It is deliberately separate from production credentials and commerce writes.

From the Agent Core repository root:

```bash
npm run sandbox
```

In another terminal:

```bash
cd starters/agent-core-js
npm start -- "desk organizer"
```

The starter calls only `/sandbox/api/search`; the local server injects an
ephemeral scope and strips purchase evidence. For a reviewed deployment, use
the versioned [Agent Core SDK](../../sdk/README.md), a deployment-issued tenant
credential held by your server, and the canonical `/api/*` or `/mcp` routes.
