import { describe, expect, it } from 'vitest';
import { formatContact, pickPrimaryEmail, validateResourceName } from '../src/utils/contacts.js';

describe('contacts utils (pure, sin red)', () => {
  it('elige el email primario y deduplica', () => {
    const { primary, all } = pickPrimaryEmail([
      { value: 'otro@empresa.com' },
      { value: 'Fulano@Empresa.com', metadata: { primary: true } },
      { value: 'fulano@empresa.com' },
      { value: 'no-es-email' },
    ]);
    expect(primary).toBe('fulano@empresa.com');
    expect(all).toEqual(['fulano@empresa.com', 'otro@empresa.com']);
  });

  it('formatea un contacto minimizando PII (sin fotos ni notas)', () => {
    const summary = formatContact({
      resourceName: 'people/c123',
      names: [{ displayName: '  Fulano   Pérez  ' }],
      emailAddresses: [{ value: 'fulano@empresa.com' }, { value: 'fulano.personal@gmail.com' }],
      organizations: [{ name: 'Empresa SA' }],
      phoneNumbers: [{ value: '+34 600 123 123' }],
      photos: [{ url: 'https://example.com/foto.jpg' }],
    } as never);
    expect(summary).toMatchObject({
      resource_name: 'people/c123',
      display_name: 'Fulano Pérez',
      primary_email: 'fulano@empresa.com',
      organization: 'Empresa SA',
    });
    expect(summary.all_emails).toHaveLength(2);
    expect(JSON.stringify(summary)).not.toContain('foto.jpg');
  });

  it('descarta contactos sin email valido', () => {
    const summary = formatContact({ resourceName: 'people/c9', names: [{ displayName: 'Sin Email' }] } as never);
    expect(summary.primary_email).toBeNull();
  });

  it('valida resourceName con formato estricto', () => {
    expect(validateResourceName('people/c123')).toBe('people/c123');
    expect(() => validateResourceName('people/')).toThrow();
    expect(() => validateResourceName('other/c123')).toThrow();
    expect(() => validateResourceName('people/c123/../x')).toThrow();
  });
});
