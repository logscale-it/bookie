# E-Rechnung: Ist-Stand (Audit)

Stand: Branch `docs/promotion-01-05`. Ehrliche Bestandsaufnahme, keine Werbeaussage.
Der offizielle KoSIT-Validator (und Mustangproject/veraPDF) konnte in dieser Umgebung
**nicht** ausgeführt werden (kein Java). Nichts hier ist gegen den KoSIT-Validator geprüft.
Formal korrekt heißt hier nur: manuell gegen die CII-Schema-Reihenfolge gelesen.

## 1. Was existiert

| Bereich | Datei | Befund |
|---|---|---|
| CII-XML-Erzeugung | `src/lib/pdf/invoice-xml.ts` (`renderInvoiceXml`, ab Z. 185) | Handgeschriebener Emitter, ZUGFeRD/Factur-X **BASIC** (`urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic`, Z. 119-123) und XRechnung 3.0 CII (`...#urn:xeinkauf.de:kosit:xrechnung_3.0`). Nur CII, kein UBL. |
| PDF/A-3-Hülle | `src/lib/pdf/invoice-pdf-a3.ts` (`createInvoicePdfA3`, Z. 103) | pdf-lib, bettet XML als `factur-x.xml` / `xrechnung.xml` ein (Z. 61-64, 135), `AFRelationship.Alternative`, XMP mit `pdfaid` 3B und `fx:`-Block, sRGB-OutputIntent ohne ICC. |
| Einstellung | `src-tauri/migrations/0024/01_einvoice_format.sql`, `src-tauri/src/lib.rs:1171` | `einvoice_format` (plain/zugferd/xrechnung) in Organisationseinstellungen; UI `src/routes/einstellungen/organisation/+page.svelte`. |
| Tests | `tests/lib/pdf/invoice-xml.test.ts`, `invoice-pdf-a3.test.ts`, `einvoice-validator.test.ts` | Struktur- und Feldtests; Mustang-Validierung nur mit `BOOKIE_TEST_MUSTANG=1` + Java (Z. 3 der Datei), hier übersprungen. |
| Empfang (neu) | `src/lib/einvoice/` (`parse.ts`, `xml.ts`, `pdf.ts`, `types.ts`, `index.ts`), `src/common/EInvoicePreview.svelte` | UBL-Invoice/CreditNote und CII lesen, XML aus ZUGFeRD/Factur-X-PDF ziehen. Siehe Abschnitt 3. |
| GoBD | `src-tauri/src/gobd.rs` | GoBD-Export (ZIP/CSV, Audit-Log). Enthält **keine** E-Rechnungs-Logik (kein Treffer für XRechnung/ZUGFeRD/CII/UBL). |
| Eingehende Rechnungen | `src/routes/eingehende-rechnungen/+page.svelte` | Vorher: nur manuelle Erfassung + Dateianhang (PDF/Bild), kein XML-Import. Jetzt: Erkennung und Vorschau (Z. ~33-34, 430-437), Original wird unverändert gespeichert (`writeLocalAttachment` / `uploadFile` nutzen `file.arrayBuffer()`). |

## 2. Wichtigster Befund: Export ist nicht angebunden

`renderInvoiceXml` und `createInvoicePdfA3` werden **nirgends** außerhalb von `src/lib/pdf/` und der Tests
aufgerufen (`grep` über `src/`). Die Einstellung `einvoice_format` wird gespeichert, aber der Rechnungs-
Export (`InvoiceForm.svelte` / `invoice-pdf-writer`) erzeugt weiterhin klassische PDFs. Nutzer können
also heute **keine** E-Rechnung aus der App exportieren. Der Hinweistext in `src/lib/i18n/de.ts:~400`
("noch nicht implementiert (COMP-3.b)") ist dazu konsistent, nennt aber ein Datum ("seit 01.01.2025"),
das **von Mensch gegen BMF/KoSIT zu prüfen** ist.

## 3. Empfang (5.2) - Entscheidung

- Eigener, winziger Namespace-ignorierender XML-Leser (`xml.ts`) statt `DOMParser`, weil `DOMParser`
  unter `bun test` fehlt und keine neue Abhängigkeit hinzukommen soll. Elemente werden per
  Local-Name-Pfad gelesen. Grenzen: keine Schema-/Namespace-URI-Prüfung, keine Validierung,
  DOCTYPE mit ENTITY wird abgelehnt.
- PDF: `pdf-lib` (bereits Abhängigkeit) liest `/Names/EmbeddedFiles` bzw. `/AF`; bevorzugt `factur-x.xml`,
  `zugferd-invoice.xml`, `xrechnung.xml`.
- Gelesen werden: Nummer, Datum, Fälligkeit, Währung, Typcode, Leitweg/Käuferreferenz, Verkäufer/Käufer
  (Name, Adresse, USt-Id, Steuernummer, E-Mail), Positionen, Steueraufschlüsselung, Summen.
  Nicht gelesen: Zahlungsangaben (IBAN), Zu-/Abschläge auf Dokumentebene, Anhänge (BG-24), Skonto.
- Die Anzeige ist eine Lesehilfe, keine Prüfung der Rechnung. Prüfung gegen EN 16931/XRechnung findet nicht statt.

## 4. Ausgang (5.3) - Abgleich gegen EN 16931 / XRechnung

Geprüft per Lesen von `invoice-xml.ts`; Elementreihenfolge entspricht der CII-Sequenz (Header-Agreement,
Delivery, Settlement; Party: Name, Adresse, Steuerregistrierung). Behoben: optionale Käuferreferenz
(BT-10) wird jetzt als `ram:BuyerReference` ausgegeben (`invoice-xml.ts` Feld `buyerReference`).

Offene Lücken (nicht behoben, nicht validiert):

1. XRechnung verlangt BT-10 (BR-DE-15): Feld existiert nun, wird aber nirgends befüllt (kein UI, keine DB-Spalte).
2. Verkäuferkontakt (BG-6: Name, Telefon, E-Mail; BR-DE-2/5/6/7) fehlt.
3. Elektronische Adressen BT-34/BT-49 (`URIUniversalCommunication`) fehlen (in XRechnung 3.0 verpflichtend; Details im Regelwerk prüfen).
4. Steuerkategorie ist hart `S`. Steuerfrei, Kleinunternehmer (§19 UStG), Reverse Charge, innergemeinschaftliche
   Lieferung brauchen Kategorien E/Z/AE/K/G und Befreiungsgrund (BR-E-*, BR-AE-*); ein 0-%-Satz mit `S` ist ungültig.
5. Einheit: `item.unit` ist Freitext (z. B. "h"); EN 16931 verlangt UN/ECE Rec. 20 Codes (`HUR`, `C62`). Fallback `C62` nur bei leerem Wert.
6. Nur BASIC-Profil für ZUGFeRD; EN16931-Profil ("COMFORT") wäre das in der Spec genannte Ziel. Das Guideline-URN dafür ist `urn:cen.eu:en16931:2017` - nicht umgesetzt.
7. Keine Zahlungsreferenz (BT-83), keine Dokumentebenen-Rabatte, keine Anzahlungen, keine Gutschrift (nur Typ 380).
8. Rundung/Summenkonsistenz (BR-CO-*) wird nicht programmatisch geprüft.
9. PDF/A-3: keine eingebetteten Schriften (Standard-14), kein ICC-Profil, kein XMP-Extension-Schema für den `fx:`-Namespace. veraPDF würde das voraussichtlich beanstanden. `XRECHNUNG` als Factur-X-Konformitätsstufe im XMP ist **zu prüfen**.
10. Kein UBL-Export (nur CII).
11. Keine automatische Validierung gegen KoSIT in Tests (kein Java); die Spec fordert dies für CI. Weiterhin offen.
12. Bibliothekswahl (Spec: "bevorzugt Rust/JS-Bibliothek, dokumentieren"): bislang handgeschrieben, keine Bibliothek bewertet.

## 5. Quellen

- EN 16931-1:2017 (Semantisches Datenmodell), CEN/TS 16931-3-x (Syntax-Bindings UBL/CII)
- XRechnung-Standard (CIUS) und Prüfregeln BR-DE-*, KoSIT / XÖV-Koordinierungsstelle: xrechnung.org, validator: github.com/itplr-kosit/validator
- Factur-X 1.0 / ZUGFeRD 2.x Spezifikation (FNFE-MPE / FeRD)
- Gesetzliche Fristen und Pflichten (Wachstumschancengesetz, BMF-Schreiben): **von Mensch gegen BMF/KoSIT zu prüfen**, hier nicht behauptet.
