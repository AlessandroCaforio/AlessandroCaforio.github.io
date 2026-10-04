# Notebook da incorporare nei post

Questa cartella non diventa una pagina del sito: il trattino basso la esclude.
È un deposito da cui i post prendono grafici e tabelle.

1. Nel notebook, come prima riga della cella che ti interessa:
   `#| label: nome-breve`
2. Esegui il notebook e **salvalo con gli output**. Il sito non lo riesegue:
   usa quello che trova salvato nel file.
3. Copia il `.ipynb` in questa cartella.
4. Nel post, su una riga da sola:

   {{< embed _notebooks/nome-file.ipynb#nome-breve >}}

   Con `echo=true` prima di `>}}` mostri anche il codice della cella.

**Tutto il notebook finisce nella repo pubblica**, non solo la cella che
incorpori. Quindi niente notebook che scaricano dati con credenziali, e niente
di LG.
