-- `surgeon` e hoje um texto so ("Nome (CRM)") que o servidor faz parse para
-- decidir acesso (server.mjs isAssignedTo). Esse vinculo e a fonte da fragilidade
-- que patient_care_team resolve, mas a string tambem e exibida na tela: o
-- paciente pat-2 aponta para "Dr. Marcos Albuquerque", que nao tem cadastro em
-- professionals, e por isso fica sem equipe.
--
-- Separar as duas coisas: patient_care_team manda no ACESSO, surgeon_label guarda
-- o rotulo exibido. O rotulo so e usado quando o paciente nao tem equipe, o que
-- mantem o padrao de acesso atual (sem equipe => todo profissional ve) sem
-- inventar um profissional inexistente nem esconder o nome na tela.

ALTER TABLE patients ADD COLUMN surgeon_label text NOT NULL DEFAULT '';
