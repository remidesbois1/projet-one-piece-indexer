function mapBubbleReorderError(error) {
  const code = error?.code;
  if (code === 'P0002') {
    return { status: 404, message: 'Page introuvable.' };
  }
  if (code === '42501') {
    return { status: 403, message: error.message || 'Réordonnancement refusé.' };
  }
  if (['22003', '22023', '23514'].includes(code)) {
    return { status: 400, message: error.message || 'Réordonnancement invalide.' };
  }
  if (code === '40001' || code === '55000') {
    return { status: 409, message: 'La page a changé, rechargez les bulles puis réessayez.' };
  }
  return { status: 500, message: "Erreur lors de la mise à jour de l'ordre." };
}

module.exports = { mapBubbleReorderError };
