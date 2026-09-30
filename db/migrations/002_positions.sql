-- A ordem dos arrays de topo tambem e load-bearing no frontend:
-- `selectedPatient` cai em patients()[0], `professionalUser()` e professionals()[0]
-- (que define ate o nome gravado em reviewedBy e no chat), e deletePatient reescreve
-- activePatientId com patients()[0]. Ordenar por id seria fragil: 'pat-10' < 'pat-2'.
-- Guardar o indice de insercao preserva a ordem exata.

ALTER TABLE patients ADD COLUMN position integer NOT NULL DEFAULT 0;
ALTER TABLE professionals ADD COLUMN position integer NOT NULL DEFAULT 0;
ALTER TABLE admins ADD COLUMN position integer NOT NULL DEFAULT 0;

CREATE INDEX patients_order_idx ON patients (position);
CREATE INDEX professionals_order_idx ON professionals (position);
