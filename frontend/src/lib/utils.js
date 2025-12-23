import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

/**
 * Crop + Zoom x3 (Upscaling)
 * Permet à l'IA de mieux voir les espaces.
 */
export async function cropImage(imageElement, rect) {
  if (!imageElement || !rect) return null;

  const PADDING = 20;
  const SCALE = 3; 

  const naturalW = imageElement.naturalWidth;
  const naturalH = imageElement.naturalHeight;

  const startX = Math.max(0, rect.x - PADDING);
  const startY = Math.max(0, rect.y - PADDING);
  
  const endX = Math.min(naturalW, rect.x + rect.w + PADDING);
  const endY = Math.min(naturalH, rect.y + rect.h + PADDING);

  const width = endX - startX;
  const height = endY - startY;

  if (width <= 0 || height <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  
  const ctx = canvas.getContext('2d');
  
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  try {
      ctx.drawImage(
          imageElement, 
          startX, startY, width, height, 
          0, 0, width * SCALE, height * SCALE 
      );
  } catch (e) {
      console.error("Erreur Crop:", e);
      return null;
  }

  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
}