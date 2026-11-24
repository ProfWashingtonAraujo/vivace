import { AdminUser, Patient, ProfessionalUser } from '../types';

export const CURRENT_ADMIN: AdminUser = {
  id: 'adm-1',
  name: 'Administrador',
  email: 'admin@vivace.med.br',
  password: 'vivace-demo'
};

export const CURRENT_PROFESSIONAL: ProfessionalUser = {
  id: 'prof-1',
  name: 'Rafaely Carvalho',
  role: 'Cirurgiã Titular do Acompanhamento',
  crmCoren: 'CRM-SP 148.920',
  avatar: 'https://images.unsplash.com/photo-1559839734-2b71ea197ec2?auto=format&fit=crop&q=80&w=300',
  email: 'rafaely.carvalho@vivace.med.br',
  password: 'vivace-demo',
  specialty: 'Cirurgia Geral e Videolaparoscópica'
};

export const INITIAL_PATIENTS: Patient[] = [
  {
    id: 'pat-1',
    name: 'Mariana Souza',
    age: 34,
    gender: 'Feminino',
    avatar: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&q=80&w=300',
    email: 'mariana.souza@email.com',
    password: 'vivace-demo',
    phone: '(11) 98452-1920',
    cpf: '342.890.118-45',
    procedure: 'Colecistectomia Laparoscópica',
    surgeryDate: '2025-05-10',
    dischargeDate: '2025-05-11',
    hospital: 'Hospital Morumbi Vivace',
    surgeon: 'Rafaely Carvalho (CRM-SP 148.920)',
    anesthesiaType: 'Geral balanceada com bloqueio TAP',
    allergies: ['Dipirona (náuseas leves)', 'Iodo tópico'],
    status: 'atencao',
    postOpDay: 3,
    lastCheckInTime: 'Hoje às 08:30',
    currentPain: 4,
    currentTemp: 37.1,
    bloodPressure: '118/76 mmHg',
    heartRate: 74,
    woundReviewPending: true,
    medicationAdherencePercent: 85,
    emergencyContact: {
      name: 'Rodrigo Souza (Esposo)',
      phone: '(11) 98123-4567',
      relationship: 'Cônjuge'
    },
    timeline: [
      {
        id: 'tl-1',
        date: '10/05/2025 08:00',
        dayLabel: 'D+0',
        title: 'Cirurgia Realizada com Sucesso',
        description: 'Procedimento por videolaparoscopia com 4 portais. Duração de 55 min sem intercorrências hemorrágicas.',
        author: 'Rafaely Carvalho',
        type: 'cirurgia'
      },
      {
        id: 'tl-2',
        date: '11/05/2025 10:30',
        dayLabel: 'D+1',
        title: 'Alta Hospitalar Concedida',
        description: 'Paciente tolerando dieta líquida/pastosa, deambulando e sem queixas álgicas agudas. Orientações domiciliares entregues.',
        author: 'Enfª. Rebeca Mendes',
        type: 'alta'
      },
      {
        id: 'tl-3',
        date: '12/05/2025 09:15',
        dayLabel: 'D+2',
        title: 'Check-in Domiciliar D+2',
        description: 'Paciente relatou dor nível 3/10. Curativos trocados e secos. Temperatura 36.7°C.',
        author: 'Mariana Souza (Paciente)',
        type: 'checkin'
      },
      {
        id: 'tl-4',
        date: '13/05/2025 08:30',
        dayLabel: 'D+3',
        title: 'Nova Foto de Curativo Enviada',
        description: 'Paciente enviou foto da incisão umbilical com leve sensação de queimação local. Aguardando validação da equipe.',
        author: 'Mariana Souza (Paciente)',
        type: 'curativo'
      }
    ],
    woundPhotos: [
      {
        id: 'wp-1',
        date: '11/05/2025',
        dayLabel: 'D+1 (Alta)',
        imageUrl: 'https://images.unsplash.com/photo-1579684385127-1ef15d508118?auto=format&fit=crop&q=80&w=600',
        patientNotes: 'Curativo feito ainda no hospital antes de vir embora.',
        reviewedBy: 'Enfª. Rebeca Mendes',
        reviewedAt: '11/05/2025 11:00',
        reviewStatus: 'avaliado_adequado',
        reviewFeedback: 'Incisões limpas, fita microporosa bem aderida, sem sinais flogísticos.'
      },
      {
        id: 'wp-2',
        date: '13/05/2025',
        dayLabel: 'D+3 (Hoje)',
        imageUrl: 'https://images.unsplash.com/photo-1584515979956-d9f6e5d09982?auto=format&fit=crop&q=80&w=600',
        patientNotes: 'Troquei o curativo após o banho como orientado. Sinto um leve ardor no umbigo.',
        reviewStatus: 'pendente'
      }
    ],
    medications: [
      {
        id: 'med-1',
        name: 'Paracetamol',
        dose: '750 mg',
        frequency: 'A cada 6 horas se dor',
        purpose: 'Alívio de dor e desconforto',
        times: ['06:00', '12:00', '18:00', '00:00'],
        instructions: 'Tomar com um copo cheio de água. Não exceder 4 comprimidos ao dia.',
        takenToday: { '06:00': true, '12:00': true, '18:00': false, '00:00': false }
      },
      {
        id: 'med-2',
        name: 'Cetoprofeno',
        dose: '100 mg',
        frequency: 'A cada 12 horas por 5 dias',
        purpose: 'Anti-inflamatório para reduzir o inchaço',
        times: ['08:00', '20:00'],
        instructions: 'Tomar logo após as refeições para proteger o estômago.',
        takenToday: { '08:00': true, '20:00': false }
      },
      {
        id: 'med-3',
        name: 'Pantoprazol',
        dose: '40 mg',
        frequency: '1x ao dia pela manhã',
        purpose: 'Protetor gástrico',
        times: ['07:00'],
        instructions: 'Tomar em jejum, 30 minutos antes do café.',
        takenToday: { '07:00': true }
      },
      {
        id: 'med-4',
        name: 'Simeticona',
        dose: '40 gotas ou 1 cápsula',
        frequency: 'Se gases ou distensão abdominal',
        purpose: 'Eliminar o gás da laparoscopia',
        times: ['14:00', '21:00'],
        instructions: 'Uso conforme necessidade de desconforto de gases no ombro/abdômen.',
        takenToday: { '14:00': true, '21:00': false }
      }
    ],
    checkIns: [
      {
        id: 'chk-1',
        date: '11/05/2025',
        dayLabel: 'D+1',
        painLevel: 5,
        temperature: 36.8,
        mobilityScore: 'repouso_absoluto',
        symptoms: ['Gases / Dor no ombro', 'Sensação de estômago pesado'],
        notes: 'Dormi bastante após chegar em casa. Tomei sopa morna.',
        mood: 'desconfortavel'
      },
      {
        id: 'chk-2',
        date: '12/05/2025',
        dayLabel: 'D+2',
        painLevel: 3,
        temperature: 36.7,
        mobilityScore: 'caminha_pouco',
        symptoms: ['Gases leves'],
        notes: 'Já consegui caminhar pela sala 3 vezes hoje.',
        mood: 'bem'
      },
      {
        id: 'chk-3',
        date: '13/05/2025',
        dayLabel: 'D+3',
        painLevel: 4,
        temperature: 37.1,
        mobilityScore: 'caminha_pouco',
        symptoms: ['Ardor leve no curativo umbilical', 'Gases ocasionais'],
        notes: 'Senti um pouco mais de desconforto ao levantar da cama.',
        mood: 'bem',
        photoUploaded: true
      }
    ],
    messages: [
      {
        id: 'msg-1',
        sender: 'equipe',
        senderName: 'Enfª. Rebeca Mendes',
        timestamp: '11/05 às 14:00',
        text: 'Olá, Mariana! Tudo bem em casa? Lembre-se de tomar água aos poucos e dar pequenas caminhadas pela sala para soltar os gases da laparoscopia.',
        isRead: true
      },
      {
        id: 'msg-2',
        sender: 'paciente',
        senderName: 'Mariana Souza',
        timestamp: '11/05 às 15:20',
        text: 'Olá, enfermeira Rebeca! Sim, estou descansando. A dor no ombro diminuiu bastante depois que tomei a Simeticona.',
        isRead: true
      },
      {
        id: 'msg-3',
        sender: 'paciente',
        senderName: 'Mariana Souza',
        timestamp: 'Hoje às 08:35',
        text: 'Acabei de enviar a foto do curativo do umbigo. Está um pouco vermelhinho em volta, é normal arder um pouco ao sentar?',
        isRead: false
      }
    ],
    instructions: [
      {
        id: 'inst-1',
        category: 'curativo',
        title: 'Cuidados com os Portais Cirúrgicos',
        content: 'Mantenha as incisões sempre limpas e secas. Durante o banho, pode deixar a água corrente e sabonete neutro escorrerem suavemente. Seque com toalha macia e limpa dando batidinhas leves, sem esfregar.',
        iconName: 'ShieldCheck',
        important: true
      },
      {
        id: 'inst-2',
        category: 'alimentacao',
        title: 'Dieta Leve e Fracionada',
        content: 'Evite alimentos gordurosos, frituras, refrigerantes e leguminosas fermentativas (feijão, repolho) nas primeiras 2 semanas. Prefira carnes magras, legumes cozidos, frutas não ácidas e muita água.',
        iconName: 'Apple'
      },
      {
        id: 'inst-3',
        category: 'atividade',
        title: 'Movimentação e Esforço Físico',
        content: 'Não pegue pesos acima de 3 kg por 30 dias. Caminhadas leves dentro de casa são muito recomendadas para ativar a circulação e evitar trombose.',
        iconName: 'Footprints'
      },
      {
        id: 'inst-4',
        category: 'alerta',
        title: 'Sinais de Alerta para Acionar a Equipe',
        content: 'Contate-nos imediatamente se tiver febre acima de 37.8°C, vômitos persistentes, dor súbita que não cede com analgésicos ou secreção amarelada/com odor nas incisões.',
        iconName: 'AlertTriangle',
        important: true
      }
    ],
    clinicalNotes: [
      {
        id: 'cn-1',
        author: 'Rafaely Carvalho',
        date: '11/05/2025 10:00',
        text: 'Paciente orientada quanto a analgesia escalonada. Retorno ambulatorial agendado para D+10 (20/05) para avaliação física e remoção de pontos se indicado.'
      }
    ]
  },
  {
    id: 'pat-2',
    name: 'Carlos Eduardo Brandão',
    age: 58,
    gender: 'Masculino',
    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80&w=300',
    email: 'carlos.brandao@email.com',
    password: 'vivace-demo',
    phone: '(11) 97120-8833',
    cpf: '128.450.772-91',
    procedure: 'Artroplastia Total de Quadril Direito',
    surgeryDate: '2025-05-12',
    dischargeDate: '2025-05-13',
    hospital: 'Hospital Morumbi Vivace',
    surgeon: 'Dr. Marcos Albuquerque (CRM-SP 120.440)',
    anesthesiaType: 'Raquianestesia com sedação endovenosa',
    allergies: ['Penicilina (urticária severa)'],
    status: 'critico',
    postOpDay: 1,
    lastCheckInTime: 'Hoje às 09:10',
    currentPain: 7,
    currentTemp: 37.8,
    bloodPressure: '135/88 mmHg',
    heartRate: 88,
    woundReviewPending: true,
    medicationAdherencePercent: 70,
    emergencyContact: {
      name: 'Cláudia Brandão (Filha)',
      phone: '(11) 97788-9900',
      relationship: 'Filha'
    },
    timeline: [
      {
        id: 'tl-c1',
        date: '12/05/2025 14:00',
        dayLabel: 'D+0',
        title: 'Prótese Implantada com Sucesso',
        description: 'Artroplastia de quadril cimentada. Rx pós-op imediato demonstra perfeito alinhamento do componente acetabular e haste femoral.',
        author: 'Dr. Marcos Albuquerque',
        type: 'cirurgia'
      },
      {
        id: 'tl-c2',
        date: '13/05/2025 09:10',
        dayLabel: 'D+1',
        title: 'Alerta Clínico: Dor Intensa e Subfebril',
        description: 'Check-in matinal registrou dor nível 7/10 e temperatura axilar 37.8°C. Paciente hesitante em levantar com andador.',
        author: 'Sistema VIVACE (Triagem Automática)',
        type: 'checkin'
      }
    ],
    woundPhotos: [
      {
        id: 'wp-c1',
        date: '13/05/2025',
        dayLabel: 'D+1',
        imageUrl: 'https://images.unsplash.com/photo-1516549655169-df83a0774514?auto=format&fit=crop&q=80&w=600',
        patientNotes: 'Curativo impermeável colocado após alta hospitalar.',
        reviewStatus: 'pendente'
      }
    ],
    medications: [
      {
        id: 'med-c1',
        name: 'Tramadol + Paracetamol',
        dose: '37.5 mg / 325 mg',
        frequency: 'A cada 8 horas se dor intensa',
        purpose: 'Controle de dor moderada a forte',
        times: ['08:00', '16:00', '00:00'],
        instructions: 'Pode causar sonolência. Tomar com auxílio de familiar.',
        takenToday: { '08:00': true, '16:00': false, '00:00': false }
      },
      {
        id: 'med-c2',
        name: 'Enoxaparina (Clexane)',
        dose: '40 mg / 0.4 mL SC',
        frequency: '1x ao dia por 28 dias',
        purpose: 'Anticoagulante profilático para prevenção de trombose',
        times: ['20:00'],
        instructions: 'Injeção subcutânea na gordura do abdômen.',
        takenToday: { '20:00': false }
      },
      {
        id: 'med-c3',
        name: 'Celecoxibe',
        dose: '200 mg',
        frequency: '1x ao dia pela manhã',
        purpose: 'Anti-inflamatório articular',
        times: ['09:00'],
        instructions: 'Tomar após café.',
        takenToday: { '09:00': true }
      }
    ],
    checkIns: [
      {
        id: 'chk-c1',
        date: '13/05/2025',
        dayLabel: 'D+1',
        painLevel: 7,
        temperature: 37.8,
        mobilityScore: 'repouso_absoluto',
        symptoms: ['Dor intensa ao apoiar pé', 'Calafrio leve', 'Medo de dobrar quadril'],
        notes: 'A dor está difícil de controlar mesmo com remédio. Estou deitado com a perna esticada.',
        mood: 'com_dor',
        photoUploaded: true
      }
    ],
    messages: [
      {
        id: 'msg-c1',
        sender: 'equipe',
        senderName: 'Enfº. Gabriel Santos',
        timestamp: 'Hoje às 09:30',
        text: 'Sr. Carlos, recebemos seu alerta de dor e febre de 37.8°C. Já notifiquei o Dr. Marcos. Vamos fazer um contato telefônico em instantes.',
        isRead: true
      }
    ],
    instructions: [
      {
        id: 'inst-c1',
        category: 'atividade',
        title: 'Posições Permitidas e Proibidas',
        content: 'NUNCA cruze as pernas ou dobre o quadril mais que 90 graus nas próximas 8 semanas. Use assento elevado no vaso sanitário.',
        iconName: 'ShieldAlert',
        important: true
      },
      {
        id: 'inst-c2',
        category: 'medicacao',
        title: 'Aplicação da Enoxaparina',
        content: 'Não pule nenhuma dose do anticoagulante noturno. É a segurança contra trombose.',
        iconName: 'Pill',
        important: true
      }
    ],
    clinicalNotes: [
      {
        id: 'cn-c1',
        author: 'Rafaely Carvalho',
        date: '13/05/2025 09:40',
        text: 'Ajuste de conduta para Carlos Eduardo: indicado antecipar dose de resgate de analgésico e acompanhar curva térmica. Em caso de persistência da febre > 38.0°C, retorno imediato para hemograma e PCR.'
      }
    ]
  },
  {
    id: 'pat-3',
    name: 'Beatriz Lima Ferreira',
    age: 29,
    gender: 'Feminino',
    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=300',
    email: 'beatriz.ferreira@email.com',
    password: 'vivace-demo',
    phone: '(11) 99312-5501',
    cpf: '419.672.003-88',
    procedure: 'Rinoplastia Estruturada',
    surgeryDate: '2025-05-06',
    dischargeDate: '2025-05-06',
    hospital: 'Hospital Morumbi Vivace',
    surgeon: 'Rafaely Carvalho (CRM-SP 148.920)',
    anesthesiaType: 'Geral com intubação orotraqueal',
    allergies: ['Nenhuma alergia conhecida'],
    status: 'estavel',
    postOpDay: 7,
    lastCheckInTime: 'Hoje às 07:45',
    currentPain: 1,
    currentTemp: 36.5,
    bloodPressure: '112/72 mmHg',
    heartRate: 68,
    woundReviewPending: false,
    medicationAdherencePercent: 96,
    emergencyContact: {
      name: 'Paula Lima (Mãe)',
      phone: '(11) 99111-2233',
      relationship: 'Mãe'
    },
    timeline: [
      {
        id: 'tl-b1',
        date: '06/05/2025',
        dayLabel: 'D+0',
        title: 'Cirurgia Realizada',
        description: 'Rinoplastia aberta estruturada com enxerto de cartilagem septal. Curativo com aquaplast.',
        author: 'Rafaely Carvalho',
        type: 'cirurgia'
      },
      {
        id: 'tl-b2',
        date: '09/05/2025',
        dayLabel: 'D+3',
        title: 'Pico de Edema Regredindo',
        description: 'Compressas geladas mantidas conforme orientação. Sem epistaxe ativa.',
        author: 'Beatriz Lima',
        type: 'checkin'
      },
      {
        id: 'tl-b3',
        date: '13/05/2025',
        dayLabel: 'D+7',
        title: 'Retorno Agendado para Retirada de Splint',
        description: 'Paciente assintomática, com excelente aspecto periorbital. Consulta presencial hoje às 16h.',
        author: 'Equipe Cirúrgica',
        type: 'curativo'
      }
    ],
    woundPhotos: [
      {
        id: 'wp-b1',
        date: '12/05/2025',
        dayLabel: 'D+6',
        imageUrl: 'https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d?auto=format&fit=crop&q=80&w=600',
        patientNotes: 'Edema sob os olhos diminuiu quase 90%.',
        reviewedBy: 'Rafaely Carvalho',
        reviewedAt: '12/05/2025 18:20',
        reviewStatus: 'avaliado_adequado',
        reviewFeedback: 'Evolução brilhante, columela íntegra e sem hematomas residuais.'
      }
    ],
    medications: [
      {
        id: 'med-b1',
        name: 'Soro Fisiológico 0.9% em Spray',
        dose: 'Jatos em ambas as narinas',
        frequency: 'A cada 2 a 3 horas acordada',
        purpose: 'Lavagem e hidratação nasal abundante',
        times: ['08:00', '11:00', '14:00', '17:00', '20:00', '23:00'],
        instructions: 'Nunca assoar o nariz. Deixar escorrer e limpar delicadamente.',
        takenToday: { '08:00': true, '11:00': true, '14:00': false, '17:00': false, '20:00': false, '23:00': false }
      }
    ],
    checkIns: [
      {
        id: 'chk-b1',
        date: '13/05/2025',
        dayLabel: 'D+7',
        painLevel: 1,
        temperature: 36.5,
        mobilityScore: 'plena',
        symptoms: ['Congestão nasal leve'],
        notes: 'Me sinto super bem, ansiosa para retirar a plaquinha no consultório hoje!',
        mood: 'otimo'
      }
    ],
    messages: [
      {
        id: 'msg-b1',
        sender: 'paciente',
        senderName: 'Beatriz Lima',
        timestamp: 'Hoje às 08:00',
        text: 'Bom dia equipe! Confirmadíssimo meu retorno às 16h hoje!',
        isRead: true
      },
      {
        id: 'msg-b2',
        sender: 'equipe',
        senderName: 'Rafaely Carvalho',
        timestamp: 'Hoje às 08:15',
        text: 'Bom dia Beatriz! Confirmado, te espero no consultório para retirarmos o curativo e avaliarmos o resultado inicial. Parabéns pelo cuidado impecável na recuperação!',
        isRead: true
      }
    ],
    instructions: [
      {
        id: 'inst-b1',
        category: 'higiene',
        title: 'Lavagem Nasal Adequada',
        content: 'Faça as lavagens com soro em temperatura ambiente. Não faça força nem tente assoar sob hipótese alguma.',
        iconName: 'Droplet',
        important: true
      }
    ],
    clinicalNotes: []
  },
  {
    id: 'pat-4',
    name: 'Roberto Dias Mendes',
    age: 46,
    gender: 'Masculino',
    avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&q=80&w=300',
    email: 'roberto.dias@email.com',
    password: 'vivace-demo',
    phone: '(11) 98765-4321',
    cpf: '209.771.884-12',
    procedure: 'Hernioplastia Inguinal Videolaparoscópica (TAPP)',
    surgeryDate: '2025-05-08',
    dischargeDate: '2025-05-09',
    hospital: 'Hospital Morumbi Vivace',
    surgeon: 'Rafaely Carvalho (CRM-SP 148.920)',
    anesthesiaType: 'Geral balanceada',
    allergies: ['Sulfas'],
    status: 'estavel',
    postOpDay: 5,
    lastCheckInTime: 'Hoje às 08:00',
    currentPain: 2,
    currentTemp: 36.6,
    bloodPressure: '124/80 mmHg',
    heartRate: 72,
    woundReviewPending: false,
    medicationAdherencePercent: 100,
    emergencyContact: {
      name: 'Juliana Mendes (Esposa)',
      phone: '(11) 98111-9988',
      relationship: 'Esposa'
    },
    timeline: [
      {
        id: 'tl-r1',
        date: '08/05/2025',
        dayLabel: 'D+0',
        title: 'Correção de Hérnia com Tela',
        description: 'Técnica laparoscópica com fixação de tela anatômica tridimensional.',
        author: 'Rafaely Carvalho',
        type: 'cirurgia'
      },
      {
        id: 'tl-r2',
        date: '13/05/2025',
        dayLabel: 'D+5',
        title: 'Evolução Fisiológica Esperada',
        description: 'Função intestinal normalizada, deambulação espontânea, sem queixa de retenção urinária.',
        author: 'Enfª. Rebeca Mendes',
        type: 'checkin'
      }
    ],
    woundPhotos: [
      {
        id: 'wp-r1',
        date: '11/05/2025',
        dayLabel: 'D+3',
        imageUrl: 'https://images.unsplash.com/photo-1584515979956-d9f6e5d09982?auto=format&fit=crop&q=80&w=600',
        patientNotes: 'Curativo retirado, apenas pontos intradérmicos.',
        reviewedBy: 'Rafaely Carvalho',
        reviewedAt: '11/05/2025 15:00',
        reviewStatus: 'avaliado_adequado',
        reviewFeedback: 'Cicatrizes discretas, sem abaulamentos ou hematomas.'
      }
    ],
    medications: [
      {
        id: 'med-r1',
        name: 'Dipirona Monoidratada',
        dose: '1g',
        frequency: 'A cada 6h apenas se desconforto',
        purpose: 'Analgésico simples',
        times: ['08:00', '14:00', '20:00'],
        instructions: 'Usar somente se sentir dor incômoda.',
        takenToday: { '08:00': false, '14:00': false, '20:00': false }
      }
    ],
    checkIns: [
      {
        id: 'chk-r1',
        date: '13/05/2025',
        dayLabel: 'D+5',
        painLevel: 2,
        temperature: 36.6,
        mobilityScore: 'caminha_bem',
        symptoms: [],
        notes: 'Sem dores significativas, apenas leve repuxo ao levantar de cadeiras baixas.',
        mood: 'otimo'
      }
    ],
    messages: [],
    instructions: [
      {
        id: 'inst-r1',
        category: 'atividade',
        title: 'Cuidado ao Dirigir e Esforço Físico',
        content: 'Não dirija até completar 10 dias de pós-operatório. Não realize exercícios abdominais por 45 dias.',
        iconName: 'Activity',
        important: true
      }
    ],
    clinicalNotes: []
  }
];
