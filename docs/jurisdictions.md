# Adding a jurisdiction

Country rules live in `src/lib/legal/`:

- `types.ts`: the `LegalProfile` interface (required PDF fields, VAT rates, reverse charge,
  small-business exemption, VAT-ID regex, layout standard, retention years) and the `LegalCountry` union.
- `profiles/<cc>.ts`: one default-exported profile per country (`de`, `at`, `ch`, `fr`, `nl`, `us`).
- `index.ts`: registers profiles in the `profiles` record; `getLegalProfile()` falls back to DE.

To add or improve a country:

1. Add the code to `LegalCountry` in `types.ts`.
2. Copy the closest `profiles/*.ts` and adjust the fields. Cite the legal source in a comment.
3. Register it in `index.ts`.
4. Add a test under `tests/` (VAT-ID regex accepts/rejects, required fields).

UI strings live in `src/lib/i18n/{de,en}.ts` (`Translations` is derived from `de.ts`).
