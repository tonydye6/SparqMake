# Interactions API Capabilities (live-verified)

Verified: 2026-07-22T16:49:06.182Z · Model: gemini-3-pro-image

## Baseline untyped inline reference

**Supported: YES**

interaction id v1_ChdnUFJnYXYzSkRyMkFqckVQMTZ1RzJBNBIXZ1BSZ2F2M0pEcjJBanJFUDE2dUcyQTQ

## Typed reference roles (reference_type on image blocks)

**Supported: NO**

rejected: BadRequestError: 400 Unknown parameter 'reference_type' at 'input[1]'. — leave INTERACTIONS_TYPED_REFS off (prose role labels remain in force)

## Abort signal on interactions.create

**Supported: YES**

rejected 256ms after abort — real cancellation works; wire fetchOptions.signal in interactions-client.ts

## Flags

- `INTERACTIONS_TYPED_REFS=on` enables typed reference roles + the 10-reference budget (interactions-client.ts). Only set it when the typed probe above says YES.
