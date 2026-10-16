<script lang="ts">
  import { SITE_URL } from "$lib/site";
</script>

<!-- RECHTLICHER HINWEIS:
     Alle [Platzhalter] unten müssen vor dem Go-live durch die echten Angaben
     der verantwortlichen Person / Firma (logscale-it) ersetzt werden. -->
<svelte:head>
  <title>Datenschutzerklärung — Bookie</title>
  <meta name="description" content="Datenschutzerklärung der Bookie-Website." />
  <meta name="robots" content="noindex" />
  <link rel="canonical" href="{SITE_URL}/de/datenschutz/" />
</svelte:head>

<div class="section">
  <div class="prose-legal">
    <h1>Datenschutzerklärung</h1>

    <h2>1. Verantwortlicher</h2>
    <p>
      Verantwortlich für die Datenverarbeitung auf dieser Website im Sinne der
      Datenschutz-Grundverordnung (DSGVO) ist:
    </p>
    <!-- TODO(legal): echte Angaben einsetzen -->
    <p>
      [Firma / vollständiger Name]<br />
      [Straße und Hausnummer]<br />
      [PLZ Ort]<br />
      E-Mail: <a href="mailto:[E-Mail-Adresse]">[E-Mail-Adresse]</a>
    </p>

    <h2>2. Allgemeine Hinweise</h2>
    <p>
      Diese Website ist eine statische Informationsseite für die
      Desktop-Anwendung Bookie. Wir verarbeiten personenbezogene Daten
      ausschließlich im Rahmen der gesetzlichen Bestimmungen (DSGVO, BDSG). Der
      Schutz deiner Daten ist uns wichtig — gerade weil Bookie als lokal
      arbeitende Anwendung konzipiert ist.
    </p>

    <h2>3. Hosting</h2>
    <p>
      Diese Website wird über GitHub Pages (GitHub, Inc., 88 Colin P Kelly Jr
      St, San Francisco, CA 94107, USA) ausgeliefert. Beim Aufruf der Website
      werden technisch notwendige Daten (z.&nbsp;B. IP-Adresse) an die Server
      von GitHub übertragen und dort unter Umständen in Logdateien verarbeitet.
      Weitere Informationen findest du in der
      <a
        href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement"
        target="_blank"
        rel="noopener">Datenschutzerklärung von GitHub</a
      >.
    </p>

    <h2>4. Cookies und Tracking</h2>
    <p>
      Diese Website setzt keine Cookies und verwendet keine Analyse-, Werbe-
      oder Tracking-Dienste.
    </p>

    <h2>5. Externe Links</h2>
    <p>
      Diese Website verlinkt auf externe Angebote, insbesondere auf github.com
      (Bookie-Repository und Release-Downloads). Beim Besuch dieser Seiten
      gelten die Datenschutzerklärungen der jeweiligen Anbieter.
    </p>

    <h2>6. Deine Rechte</h2>
    <p>
      Du hast das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16
      DSGVO), Löschung (Art. 17 DSGVO), Einschränkung der Verarbeitung (Art. 18
      DSGVO), Datenübertragbarkeit (Art. 20 DSGVO) und Widerspruch (Art. 21
      DSGVO). Außerdem hast du das Recht, dich bei einer
      Datenschutz-Aufsichtsbehörde zu beschweren.
    </p>

    <h2>7. Kontakt</h2>
    <!-- TODO(legal): echte Angaben einsetzen -->
    <p>Bei Fragen zum Datenschutz erreichst du uns unter: [E-Mail-Adresse]</p>
  </div>
</div>
