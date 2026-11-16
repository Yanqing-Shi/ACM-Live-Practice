// The wire protocol is defined once, in the backend. These are type-only
// re-exports, so nothing from the backend ends up in the browser bundle.
export type * from "../../backend/src/protocol";
