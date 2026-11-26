// Faixas de saturação de oxigênio (SpO2) mostradas à equipe. O servidor trata abaixo de 90%
// como crítico e de 90 a 94% como atenção (db/store.mjs, severityFor).
export interface Spo2Band { label: string; textClass: string }

export function spo2Band(value: number | null | undefined): Spo2Band {
  if (value === null || value === undefined) return { label: 'Sem medição', textClass: 'text-[#52627A]' };
  if (value >= 95) return { label: 'Normal', textClass: 'text-[#065F46]' };
  if (value >= 90) return { label: 'Hipóxia leve', textClass: 'text-[#92400E]' };
  if (value >= 85) return { label: 'Hipóxia moderada', textClass: 'text-[#C2412D]' };
  return { label: 'Hipóxia grave', textClass: 'text-[#991B1B]' };
}
