---
name: effect-v4
description: Use the repository's local Effect v4 reference for every backend implementation, review, migration, and test decision.
workflow: implement-ui-playground-demo-cutover
---

Before changing Effect code, read `docs/references/effect-smol/LLMS.md` and the
specific local reference pages it links to. Match the repository's Effect v4
beta APIs and error, schema, service, layer, and lifecycle conventions. Do not
copy older Effect patterns from memory. Keep migration and lifecycle behavior
strict, test failure paths, and report the exact reference sections used.
