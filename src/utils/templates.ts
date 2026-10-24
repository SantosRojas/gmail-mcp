export interface BuiltinTemplate {
  name: string;
  description: string;
  subject: string;
  body: string;
  variables: string[];
}

const TEMPLATES: BuiltinTemplate[] = [
  {
    name: 'felicitacion',
    description: 'Felicitación corporativa con encabezado oscuro y acento dorado (HTML). Variables: {{nombre}}.',
    subject: 'Felicitaciones por tu gran labor',
    body: `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#FAF6F0;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e8e0d4;border-radius:10px;overflow:hidden;">
<div style="background:#0F0F0F;padding:28px 24px;text-align:center;">
<div style="color:#C9A86A;font-size:13px;letter-spacing:3px;margin-bottom:8px;">TU EMPRESA</div>
<div style="color:#ffffff;font-size:24px;font-weight:bold;">¡Felicitaciones, {{nombre}}!</div>
</div>
<div style="padding:28px 24px;color:#222222;">
<p style="font-size:15px;line-height:1.6;">Queremos reconocer tu <strong>gran labor</strong>. Gracias por tu compromiso, excelencia y pasión.</p>
</div>
<div style="background:#0F0F0F;padding:16px;text-align:center;color:#C9A86A;font-size:12px;">Tu empresa · Belleza que conecta</div>
</div>
</body></html>`,
    variables: ['nombre'],
  },
  {
    name: 'cumpleanos',
    description: 'Saludo de cumpleaños moderno (HTML). Variables: {{nombre}}.',
    subject: '¡Feliz cumpleaños, {{nombre}}!',
    body: `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#FFF8F0;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #f0e2cc;">
<div style="background:#7c3aed;padding:28px 24px;text-align:center;color:#ffffff;font-size:24px;font-weight:bold;">¡Feliz cumpleaños, {{nombre}}! 🎉</div>
<div style="padding:28px 24px;color:#333333;"><p style="font-size:15px;line-height:1.6;">Que este nuevo año te traiga alegría, salud y muchos éxitos. ¡Celebremos juntos!</p></div>
</div>
</body></html>`,
    variables: ['nombre'],
  },
  {
    name: 'reunion',
    description: 'Convocatoria de reunión sobria en texto plano. Variables: {{tema}}, {{fecha}}, {{lugar}}.',
    subject: 'Reunión: {{tema}}',
    body: 'Hola,\n\nTe invito a la reunión "{{tema}}" el {{fecha}} en {{lugar}}.\n\nSaludos.',
    variables: ['tema', 'fecha', 'lugar'],
  },
];

export function listTemplates(): BuiltinTemplate[] {
  return TEMPLATES.map((template) => ({ ...template, variables: [...template.variables] }));
}

/** Renders a template substituting {{variable}} placeholders. Pure and unit-testable. */
export function renderTemplate(name: string, variables: Record<string, string> = {}): { subject: string; body: string } {
  const template = TEMPLATES.find((entry) => entry.name === name);
  if (!template) throw new Error(`Plantilla desconocida: "${name}". Disponibles: ${TEMPLATES.map((entry) => entry.name).join(', ')}.`);
  const apply = (text: string): string => text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key: string) => variables[key] ?? match);
  return { subject: apply(template.subject), body: apply(template.body) };
}
