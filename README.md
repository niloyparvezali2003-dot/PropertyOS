# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## History & Audit Trail

The History page records new workspace actions for property, room, tenant, assignment, meter, rate, bill, payment, and advance-credit workflows. Events are stored in the owner's `auditEvents` collection and the Firestore rules allow them to be read or created by the owner, but not updated or deleted.

Publish the included `firestore.rules` file in Firebase Console before using this page. Audit events start when this version is deployed; the app does not fabricate or backfill actions from before audit logging existed. Audit writes run after a business operation commits and are best-effort, so a history-write failure does not make a saved payment or bill appear to have failed.

PDF layout work is intentionally separate. Do not build or change the PDF format until the desired sample layout has been provided and approved.
