/** Ole's names: only what people see and what would collide with a real Yogurt install on the same Mac */
export const PRODUCT_NAME = 'Ole'
export const APP_ID = 'net.cjett.ole'
export const DATA_FOLDER = 'Ole'

/** User-visible text with Yogurt's product name replaced; keys and internal names untouched. */
export function brand(text: string): string {
  return text.replace(/\bYogurt\b/g, PRODUCT_NAME)
}
