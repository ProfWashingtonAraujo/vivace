// Faixas de pressão arterial mostradas à equipe. O servidor trata 180/120 ou mais, e abaixo de
// 90/60, como crítico; 140/90 ou mais como atenção (db/store.mjs, severityFor).
export interface PressureBand { label: string; textClass: string; critical: boolean }

export function pressureBand(systolic: number | null | undefined, diastolic: number | null | undefined): PressureBand {
  if (systolic == null || diastolic == null) return { label: 'Sem medição', textClass: 'text-[#52627A]', critical: false };
  if (systolic >= 180 || diastolic >= 120) return { label: 'Crise hipertensiva', textClass: 'text-[#991B1B]', critical: true };
  if (systolic < 90 || diastolic < 60) return { label: 'Pressão baixa', textClass: 'text-[#C2412D]', critical: true };
  if (systolic >= 140 || diastolic >= 90) return { label: 'Pressão alta', textClass: 'text-[#92400E]', critical: false };
  return { label: 'Normal', textClass: 'text-[#065F46]', critical: false };
}

// O prontuário guarda o último valor como texto ("120/80 mmHg"). "Não informado" é o cadastro novo.
export function pressureBandFromText(text: string | null | undefined): PressureBand {
  const match = /^(\d+)\s*\/\s*(\d+)/.exec(text ?? '');
  return match ? pressureBand(Number(match[1]), Number(match[2])) : pressureBand(null, null);
}
