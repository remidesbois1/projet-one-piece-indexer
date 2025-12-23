import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

/**
 * Découpe une portion de l'image avec un PADDING (marge) de sécurité.
 * Cela évite que le texte soit collé aux bords, ce qui perturbe l'OCR.
 */
export async function cropImage(imageElement, rect) {
  if (!imageElement || !rect) return null;

  // MARGE DE SÉCURITÉ (En pixels)
  // 20px permet d'inclure un peu de blanc autour du texte sélectionné
  const PADDING = 10;

  // Dimensions réelles de l'image source
  const naturalW = imageElement.naturalWidth;
  const naturalH = imageElement.naturalHeight;

  // Calcul des nouvelles coordonnées élargies
  // On utilise Math.max/min pour ne pas sortir de l'image (pas de coordonnées négatives)
  const startX = Math.max(0, rect.x - PADDING);
  const startY = Math.max(0, rect.y - PADDING);
  
  const endX = Math.min(naturalW, rect.x + rect.w + PADDING);
  const endY = Math.min(naturalH, rect.y + rect.h + PADDING);

  const width = endX - startX;
  const height = endY - startY;

  // Sécurité anti-crash
  if (width <= 0 || height <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  
  const ctx = canvas.getContext('2d');

  // Fond blanc par sécurité (pour la transparence éventuelle)
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, width, height);

  try {
      ctx.drawImage(
          imageElement, 
          startX, startY, width, height, // Source (Zone élargie)
          0, 0, width, height            // Destination
      );
  } catch (e) {
      console.error("Erreur Crop:", e);
      return null;
  }

  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
}

/**
 * Corrige la casse et la ponctuation du texte manga.
 * Version V3 : Gestion agressive des espaces manquants.
 */
export function fixMangaCase(text) {
    if (!text) return "";

    let fixed = text;

    // 1. Décollage de la ponctuation (Le plus important pour ton problème)
    // "Mot?Suite" => "Mot ? Suite"
    fixed = fixed.replace(/([a-zA-Zà-ÿ])([?!:;])/g, '$1 $2'); 
    fixed = fixed.replace(/([?!:;])([a-zA-Zà-ÿ])/g, '$1 $2');
    
    // 2. Remplacement des sauts de ligne par des espaces
    // Les OCR mettent souvent des \n. On les transforme en espaces pour éviter les mots collés.
    fixed = fixed.replace(/\n/g, ' ');

    // 3. Minuscules
    fixed = fixed.toLowerCase();

    // 4. Capitalisation Phrases
    fixed = fixed.replace(/(^\s*|[.!?…]\s+)([a-zà-ÿ])/g, (match) => match.toUpperCase());

    // 5. Corrections Spécifiques
    fixed = fixed
        .replace(/\bje\b/g, "Je")      
        .replace(/\bj['’]/g, "J'")     
        .replace(/\b(ça|ca)\b/g, "ça")
        .replace(/\s+/g, ' ') // Supprime les doubles espaces créés par le padding/regex
        .trim();

    // 6. Dictionnaire des Noms Propres (One Piece)
    const KEYWORDS = [
        "One Piece", "Grand Line", "New World", "Nouveau Monde", "All Blue", 
        "Laugh Tale", "Raftel", "Red Line", "Calm Belt", "Log Pose", "Vivre Card",
        "Berry", "Berries", "Haki", "Fruit du Démon", "Zoan", "Logia", "Paramecia",
        "Gouvernement Mondial", "Marine", "Marines", "Cipher Pol", "Impel Down",
        "Wano", "Alabasta", "Dressrosa", "Skypiea", "Water Seven", "Enies Lobby",
        "Mugiwara", "Yonko", "Empereur", "Amiral", "Corsaire", "Shichibukai", 
        "Tenryubito", "D.", "Joy Boy", "Roi des Pirates",
        "Luffy", "Zoro", "Nami", "Usopp", "Sanji", "Chopper", "Robin", "Franky", 
        "Brook", "Jinbe", "Vivi", "Yamato", "Momonosuke",
        "Ace", "Sabo", "Shanks", "Roger", "Whitebeard", "Barbe Blanche", 
        "Blackbeard", "Barbe Noire", "Kaido", "Big Mom", "Linlin",
        "Law", "Kid", "Buggy", "Mihawk", "Hancock", "Doflamingo", "Crocodile",
        "Akainu", "Kizaru", "Aokiji", "Fujitora", "Ryokugyu", "Garp", "Sengoku",
        "Dragon", "Imu", "Vegapunk"
    ];

    KEYWORDS.forEach(word => {
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        fixed = fixed.replace(regex, word);
    });

    return fixed;
}