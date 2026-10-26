# Leksehjelp

Studer og pugg et tema basert på ditt eget stoff. Legg inn tekst, PDF eller bilder av dokumenter (eller ta bilde), og:

- 💬 snakk med appen om temaet (muntlig eller skriftlig)
- ❓ ta quiz – skriftlig eller muntlig
- 🎓 hør et foredrag om temaet
- 📝 få et sammendrag (lest opp eller skrevet)
- 🔎 sjekk stoffet mot Wikipedia

Appen holder seg til faktaene i stoffet du gir den. Norsk som standard, engelsk når du ber om det.

**Åpne appen:** https://khalm.github.io/Leksehjelp/

For full funksjon: legg inn en gratis Gemini-nøkkel fra https://aistudio.google.com/apikey under ⚙.

## AI-nøkkel
Nøkkelen ligger som secret `LEKSEHJELP_GEMINI_API_KEY`. Workflowen *Deploy AI-proxy* legger den i en gratis Cloudflare Worker (krever også secret `CLOUDFLARE_API_TOKEN`) og skriver worker-adressen til `config.js`. Nøkkelen havner aldri i selve appen.
