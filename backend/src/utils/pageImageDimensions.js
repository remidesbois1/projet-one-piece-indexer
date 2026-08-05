function getOrientedImageDimensions(metadata) {
  const oriented = metadata?.autoOrient;
  const width = Number(oriented?.width ?? metadata?.width);
  const height = Number(oriented?.height ?? metadata?.height);
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    return null;
  }
  return { width, height };
}

module.exports = { getOrientedImageDimensions };
