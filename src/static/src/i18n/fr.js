/**
 * Copy française centralisée (SPA). Terminologie : « livre » pour le projet et l’objet éditorial.
 */

export const FR = {
  book: {
    genreFallback: "Livre",
    exportSubtitle: "Votre livre",
    previewLabel: "Aperçu du texte",
    healthSection: "Santé du livre",
    cockpitTagline: "Un cockpit éditorial pour piloter votre livre.",
  },
  dashboard: {
    activeProjects: count => `${count} livre${count === 1 ? "" : "s"} actif${count === 1 ? "" : "s"}`,
    recentBooks: "Livres récents",
    emptyTitle: "Aucun livre pour l’instant",
    emptyHint: "Créez votre premier projet.",
  },
  structure: {
    subtitle: "Plan du livre",
  },
  mindmap: {
    emptyHint:
      "Reliez les nœuds directement dans le graphe ou importez vos entités du projet.",
  },
  help: {
    exportSectionTitle: "Votre livre",
    exportBullets: [
      "PDF, EPUB, HTML, texte.",
      "Liminaires et annexes inclus.",
      "Mise en page livre.",
    ],
  },
  common: {
    retry: "Réessayer",
    saved: "Sauvé",
    errorGeneric: "Une erreur est survenue.",
  },
};

export function t(path, ...args) {
  const parts = path.split(".");
  let cur = FR;
  for (const p of parts) {
    cur = cur?.[p];
  }
  if (typeof cur === "function") return cur(...args);
  if (cur !== undefined && cur !== null) return cur;
  return path;
}
