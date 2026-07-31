export function canDownloadMissingLocalModel(status, downloadActive = false) {
    return !status?.installed && !downloadActive;
}
