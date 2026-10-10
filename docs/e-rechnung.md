# E-Rechnung in Bookie (Anwenderhandbuch)

> Hinweis: Bookie ersetzt keine Rechts- oder Steuerberatung. Alle Fristen und Pflichten
> (wer ab wann empfangen/senden muss) sind **von Mensch gegen BMF/KoSIT zu prüfen**,
> bevor Sie sich darauf verlassen. Dieses Dokument nennt bewusst keine Stichtage.

## Was Bookie kann

**Eingehende E-Rechnungen lesen (verfügbar).** Unter *Eingehende Rechnungen* können Sie hochladen:

- eine XRechnung als XML (Syntax UBL oder CII),
- ein ZUGFeRD-/Factur-X-PDF (PDF mit eingebettetem XML).

Bookie erkennt das Format, zeigt Lieferant, Rechnungsnummer, Datum, Positionen und Summen an und kann
auf Knopfdruck *Daten übernehmen*, um das Erfassungsformular vorzubefüllen. Bitte Werte prüfen,
bevor Sie speichern.

**Archivierung.** Die hochgeladene Originaldatei wird byte-genau und unverändert gespeichert (lokal oder S3).
Bookie liest die Datei nur, sie wird nie umgeschrieben. Bei einem ZUGFeRD-PDF bleibt das XML darin enthalten.
Ob und wie lange Sie das Original aufbewahren müssen, klären Sie bitte mit Ihrer Steuerberatung (GoBD).

**Ausgehende E-Rechnungen (noch nicht in der Oberfläche).** Bausteine für ZUGFeRD (BASIC) und XRechnung (CII)
existieren im Code, sind aber noch nicht mit dem Rechnungs-Export verbunden. Siehe `docs/e-rechnung-status.md`.
Verwenden Sie Bookie derzeit **nicht**, wenn Sie sich auf eine fertig validierte E-Rechnung verlassen müssen.

## Grenzen

- Keine Validierung. Bookie prüft nicht, ob eine Rechnung EN 16931 oder der XRechnung-Prüfung entspricht.
  Verbindlich ist der offizielle KoSIT-Validator.
- Gelesen werden die gängigen Felder; Zahlungsangaben (IBAN), Anhänge und Dokument-Rabatte werden nicht angezeigt.
- Gutschriften (UBL CreditNote, Typcode 381) werden gelesen, aber nicht gesondert verbucht.
- Beträge werden aus der Datei übernommen, nicht neu berechnet.

## Fehlerbehebung

- *"E-Rechnung konnte nicht gelesen werden"*: Die XML ist fehlerhaft oder keine UBL-/CII-Rechnung. Die Datei
  lässt sich trotzdem als normaler Anhang speichern.
- PDF ohne Erkennung: Es enthält vermutlich kein eingebettetes XML (normale PDF-Rechnung).

## Quellen

- EN 16931-1:2017 und Syntax-Bindings CEN/TS 16931-3 (UBL, CII)
- XRechnung-Standard (CIUS), KoSIT: https://xeinkauf.de/xrechnung/ , Validator: https://github.com/itplr-kosit/validator
- ZUGFeRD / Factur-X: https://www.ferd-net.de/ , https://fnfe-mpe.org/factur-x/
