// Map DSH peer packages to tiny stubs so apply() can be exercised outside a harness.
const stubs = {
  '@deepseek-ai/dsh-tools': new URL('./dsh-tools.mjs', import.meta.url).href,
  '@deepseek-ai/schemastery': new URL('./schemastery.mjs', import.meta.url).href,
}
export async function resolve(specifier, context, next) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true }
  return next(specifier, context)
}
