// Decimal bytes: 10 MB decoded image, plus base64 expansion and envelope room.
// Keep ingress, direct JSON classification, and health metadata in sync.
export const MAX_IMAGE_BYTES = 10_000_000;
export const MAX_BASE64_CHARS = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
export const MAX_REQUEST_BYTES = MAX_BASE64_CHARS + 64 * 1024;
export const IMAGE_LIMIT_MESSAGE = 'Image exceeds 10 MB. Resize or compress the photo first.';
export const REQUEST_LIMIT_MESSAGE = 'Image request is too large. Maximum image size is 10 MB.';
