'use strict';

// Trickstep Tower — strings for the Settings tabs and the Graphics panel.
// The rest of the game is English-only; this panel follows navigator.language.

const EN = {
  tabGeneral: 'General', tabGraphics: 'Graphics',
  intro: 'Changes apply immediately and are saved on this device.',
  quality: 'Quality', auto: 'Auto (detected: {tier})',
  preset_low: 'Low', preset_balanced: 'Balanced', preset_high: 'High', preset_ultra: 'Ultra',
  renderScale: 'Render scale', fromPreset: 'From preset ({tier})',
  cat_shadows: 'Shadows', cat_ao: 'Ambient occlusion', cat_bloom: 'Bloom', cat_grade: 'Colour grading',
  cat_antialias: 'Anti-aliasing', cat_particles: 'Particles', cat_background: 'Background', cat_detail: 'Detail',
  tier_off: 'Off', tier_on: 'On', tier_low: 'Low', tier_medium: 'Medium', tier_high: 'High',
  tier_fxaa: 'FXAA', tier_smaa: 'SMAA', tier_msaa: 'MSAA',
  tier_static: 'Static', tier_animated: 'Animated', tier_plain: 'Plain', tier_detailed: 'Detailed',
  adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
  postUnavailable: 'Post-processing is unavailable on this device; rendering without it.',
};

const STRINGS = {
  'en-US': Object.assign({}, EN, { cat_grade: 'Color grading' }),
  'en-GB': EN,
  'es-419': {
    tabGeneral: 'General', tabGraphics: 'Gráficos',
    intro: 'Los cambios se aplican al instante y se guardan en este dispositivo.',
    quality: 'Calidad', auto: 'Automática (detectada: {tier})',
    preset_low: 'Baja', preset_balanced: 'Equilibrada', preset_high: 'Alta', preset_ultra: 'Ultra',
    renderScale: 'Escala de renderizado', fromPreset: 'Según el ajuste ({tier})',
    cat_shadows: 'Sombras', cat_ao: 'Oclusión ambiental', cat_bloom: 'Resplandor', cat_grade: 'Corrección de color',
    cat_antialias: 'Antialiasing', cat_particles: 'Partículas', cat_background: 'Fondo', cat_detail: 'Detalle',
    tier_off: 'No', tier_on: 'Sí', tier_low: 'Bajas', tier_medium: 'Medias', tier_high: 'Altas',
    tier_fxaa: 'FXAA', tier_smaa: 'SMAA', tier_msaa: 'MSAA',
    tier_static: 'Estático', tier_animated: 'Animado', tier_plain: 'Simple', tier_detailed: 'Detallado',
    adaptive: 'Resolución adaptable', showFps: 'Mostrar cuadros por segundo',
    postUnavailable: 'El posprocesamiento no está disponible en este dispositivo; se renderiza sin él.',
  },
  'es-ES': {
    tabGeneral: 'General', tabGraphics: 'Gráficos',
    intro: 'Los cambios se aplican al momento y se guardan en este dispositivo.',
    quality: 'Calidad', auto: 'Automática (detectada: {tier})',
    preset_low: 'Baja', preset_balanced: 'Equilibrada', preset_high: 'Alta', preset_ultra: 'Ultra',
    renderScale: 'Escala de renderizado', fromPreset: 'Según el preajuste ({tier})',
    cat_shadows: 'Sombras', cat_ao: 'Oclusión ambiental', cat_bloom: 'Resplandor', cat_grade: 'Etalonaje de color',
    cat_antialias: 'Suavizado de bordes', cat_particles: 'Partículas', cat_background: 'Fondo', cat_detail: 'Detalle',
    tier_off: 'No', tier_on: 'Sí', tier_low: 'Bajas', tier_medium: 'Medias', tier_high: 'Altas',
    tier_fxaa: 'FXAA', tier_smaa: 'SMAA', tier_msaa: 'MSAA',
    tier_static: 'Estático', tier_animated: 'Animado', tier_plain: 'Sencillo', tier_detailed: 'Detallado',
    adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo',
    postUnavailable: 'El posprocesado no está disponible en este dispositivo; se renderiza sin él.',
  },
  'de-DE': {
    tabGeneral: 'Allgemein', tabGraphics: 'Grafik',
    intro: 'Änderungen gelten sofort und werden auf diesem Gerät gespeichert.',
    quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})',
    preset_low: 'Niedrig', preset_balanced: 'Ausgewogen', preset_high: 'Hoch', preset_ultra: 'Ultra',
    renderScale: 'Renderskalierung', fromPreset: 'Aus Voreinstellung ({tier})',
    cat_shadows: 'Schatten', cat_ao: 'Umgebungsverdeckung', cat_bloom: 'Bloom', cat_grade: 'Farbkorrektur',
    cat_antialias: 'Kantenglättung', cat_particles: 'Partikel', cat_background: 'Hintergrund', cat_detail: 'Details',
    tier_off: 'Aus', tier_on: 'An', tier_low: 'Niedrig', tier_medium: 'Mittel', tier_high: 'Hoch',
    tier_fxaa: 'FXAA', tier_smaa: 'SMAA', tier_msaa: 'MSAA',
    tier_static: 'Statisch', tier_animated: 'Animiert', tier_plain: 'Schlicht', tier_detailed: 'Detailliert',
    adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
    postUnavailable: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; es wird ohne sie gerendert.',
  },
  'fr-FR': {
    tabGeneral: 'Général', tabGraphics: 'Graphismes',
    intro: 'Les changements s’appliquent immédiatement et sont enregistrés sur cet appareil.',
    quality: 'Qualité', auto: 'Auto (détectée : {tier})',
    preset_low: 'Basse', preset_balanced: 'Équilibrée', preset_high: 'Haute', preset_ultra: 'Ultra',
    renderScale: 'Échelle de rendu', fromPreset: 'Selon le préréglage ({tier})',
    cat_shadows: 'Ombres', cat_ao: 'Occlusion ambiante', cat_bloom: 'Flou lumineux', cat_grade: 'Étalonnage des couleurs',
    cat_antialias: 'Anticrénelage', cat_particles: 'Particules', cat_background: 'Arrière-plan', cat_detail: 'Détails',
    tier_off: 'Non', tier_on: 'Oui', tier_low: 'Basses', tier_medium: 'Moyennes', tier_high: 'Hautes',
    tier_fxaa: 'FXAA', tier_smaa: 'SMAA', tier_msaa: 'MSAA',
    tier_static: 'Statique', tier_animated: 'Animé', tier_plain: 'Simple', tier_detailed: 'Détaillé',
    adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde',
    postUnavailable: 'Le post-traitement n’est pas disponible sur cet appareil ; rendu sans lui.',
  },
  'fr-CA': {
    tabGeneral: 'Général', tabGraphics: 'Graphiques',
    intro: 'Les changements s’appliquent immédiatement et sont enregistrés sur cet appareil.',
    quality: 'Qualité', auto: 'Automatique (détectée : {tier})',
    preset_low: 'Basse', preset_balanced: 'Équilibrée', preset_high: 'Élevée', preset_ultra: 'Ultra',
    renderScale: 'Échelle de rendu', fromPreset: 'Selon le préréglage ({tier})',
    cat_shadows: 'Ombres', cat_ao: 'Occlusion ambiante', cat_bloom: 'Halo lumineux', cat_grade: 'Correction des couleurs',
    cat_antialias: 'Anticrénelage', cat_particles: 'Particules', cat_background: 'Arrière-plan', cat_detail: 'Détails',
    tier_off: 'Désactivé', tier_on: 'Activé', tier_low: 'Basses', tier_medium: 'Moyennes', tier_high: 'Élevées',
    tier_fxaa: 'FXAA', tier_smaa: 'SMAA', tier_msaa: 'MSAA',
    tier_static: 'Statique', tier_animated: 'Animé', tier_plain: 'Simple', tier_detailed: 'Détaillé',
    adaptive: 'Résolution adaptative', showFps: 'Afficher la fréquence d’images',
    postUnavailable: 'Le post-traitement n’est pas offert sur cet appareil; rendu sans celui-ci.',
  },
  'pt-BR': {
    tabGeneral: 'Geral', tabGraphics: 'Gráficos',
    intro: 'As alterações valem na hora e ficam salvas neste dispositivo.',
    quality: 'Qualidade', auto: 'Automática (detectada: {tier})',
    preset_low: 'Baixa', preset_balanced: 'Equilibrada', preset_high: 'Alta', preset_ultra: 'Ultra',
    renderScale: 'Escala de renderização', fromPreset: 'Da predefinição ({tier})',
    cat_shadows: 'Sombras', cat_ao: 'Oclusão ambiente', cat_bloom: 'Brilho', cat_grade: 'Correção de cor',
    cat_antialias: 'Antisserrilhado', cat_particles: 'Partículas', cat_background: 'Fundo', cat_detail: 'Detalhe',
    tier_off: 'Desligado', tier_on: 'Ligado', tier_low: 'Baixas', tier_medium: 'Médias', tier_high: 'Altas',
    tier_fxaa: 'FXAA', tier_smaa: 'SMAA', tier_msaa: 'MSAA',
    tier_static: 'Estático', tier_animated: 'Animado', tier_plain: 'Simples', tier_detailed: 'Detalhado',
    adaptive: 'Resolução adaptável', showFps: 'Mostrar taxa de quadros',
    postUnavailable: 'O pós-processamento não está disponível neste dispositivo; renderizando sem ele.',
  },
  'it-IT': {
    tabGeneral: 'Generali', tabGraphics: 'Grafica',
    intro: 'Le modifiche si applicano subito e vengono salvate su questo dispositivo.',
    quality: 'Qualità', auto: 'Automatica (rilevata: {tier})',
    preset_low: 'Bassa', preset_balanced: 'Bilanciata', preset_high: 'Alta', preset_ultra: 'Ultra',
    renderScale: 'Scala di rendering', fromPreset: 'Dal preset ({tier})',
    cat_shadows: 'Ombre', cat_ao: 'Occlusione ambientale', cat_bloom: 'Bagliore', cat_grade: 'Correzione colore',
    cat_antialias: 'Antialiasing', cat_particles: 'Particelle', cat_background: 'Sfondo', cat_detail: 'Dettaglio',
    tier_off: 'No', tier_on: 'Sì', tier_low: 'Basse', tier_medium: 'Medie', tier_high: 'Alte',
    tier_fxaa: 'FXAA', tier_smaa: 'SMAA', tier_msaa: 'MSAA',
    tier_static: 'Statico', tier_animated: 'Animato', tier_plain: 'Semplice', tier_detailed: 'Dettagliato',
    adaptive: 'Risoluzione adattiva', showFps: 'Mostra frequenza fotogrammi',
    postUnavailable: 'La post-elaborazione non è disponibile su questo dispositivo; rendering senza.',
  },
};

export const GFX_LOCALES = Object.keys(STRINGS);

const FALLBACK = { en: 'en-US', es: 'es-ES', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };
const LATAM = /^es-(4\d\d|AR|BO|CL|CO|CR|CU|DO|EC|GT|HN|MX|NI|PA|PE|PR|PY|SV|US|UY|VE)$/i;

/** Best supported locale for a BCP-47 tag (defaults to en-US). */
export function pickLocale(tag) {
  const t = String(tag || '');
  const exact = GFX_LOCALES.find(l => l.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  if (LATAM.test(t)) return 'es-419';
  if (/^fr-CA$/i.test(t)) return 'fr-CA';
  return FALLBACK[t.slice(0, 2).toLowerCase()] || 'en-US';
}

/** Translator for a locale: t(key, {tier}) with English fallback. */
export function gfxStrings(locale) {
  const table = STRINGS[pickLocale(locale)] || STRINGS['en-US'];
  return (key, vars) => {
    let s = table[key] !== undefined ? table[key] : (EN[key] !== undefined ? EN[key] : key);
    if (vars) for (const k in vars) s = s.replace('{' + k + '}', vars[k]);
    return s;
  };
}
