# Azul Gestao Landing

Landing page comercial do Azul Gestao.

## Estrutura

- `index.html`: conteudo da pagina.
- `styles.css`: design responsivo.
- `script.js`: menu mobile.
- `vercel.json`: configuracao simples para Vercel.

## Testar localmente

Pode abrir `index.html` diretamente no navegador.

Opcional:

```bash
npx serve .
```

## Publicar no Vercel

1. Criar um repositorio GitHub novo, por exemplo `azul-gestao-landing`.
2. Enviar este projeto para o GitHub.
3. No Vercel, importar esse repositorio como um projeto novo.
4. Framework preset: `Other`.
5. Root directory: `./`.
6. Build command: vazio.
7. Output directory: vazio.

Esta landing nao precisa de Supabase porque nao guarda dados. O botao principal envia o visitante para WhatsApp.
