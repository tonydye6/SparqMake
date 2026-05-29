export * from "./generated/api";
export * from "./generated/types";

// The zod client (`./generated/api`) and the generated TypeScript schemas
// (`./generated/types`) both export members named `GenerateVideoBody`,
// `UploadFileBody`, and `UploadVariantAudioBody`, which makes them ambiguous
// across the two `export *` statements above. Re-export them explicitly from
// the zod client so the runtime schemas win and the ambiguity is resolved.
export {
  GenerateVideoBody,
  UploadFileBody,
  UploadVariantAudioBody,
} from "./generated/api";
