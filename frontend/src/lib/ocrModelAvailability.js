export function isSelectableOcrModel(model, isSandbox = false) {
    return Boolean(model && model.key !== 'gemini' && (!isSandbox || model.type !== 'api'));
}
