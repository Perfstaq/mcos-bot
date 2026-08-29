# Vendored fonts — provenance and licence

Three faces, all **SIL Open Font License 1.1** (full text in `OFL.txt`). They are
02_MOTION_SYSTEM §7's three typography tokens, and they are vendored rather than
fetched because ADR-7 wants the render bundle deterministic offline on Lambda and
G13 wants two renders of one plan to agree — a host-dependent font stack breaks both.

| §7 token | Family | Upstream version | Copyright |
|---|---|---|---|
| `display_condensed` | Bebas Neue | 2.000 | Copyright 2019 The Bebas Neue Project Authors — https://github.com/dharmatype/Bebas-Neue |
| `display_serif` | Playfair Display | 1.203 | Copyright 2017 The Playfair Display Project Authors — https://github.com/clauseggers/Playfair-Display, with Reserved Font Name "Playfair Display" |
| `body_sans` | Inter | 4.001 | Copyright 2016 The Inter Project Authors — https://github.com/rsms/inter |

02 §7 names the condensed token "Anton / Bebas-class"; Bebas Neue **is** one of the
two faces it names, so this is the token, not a substitute for it.

## Source

Copied from the port source at
`/Users/sathvik/aix/founder-journey/remotion/public/fonts/` — the same OFL set
ARCHITECTURE.md §1.1 tells us to port (`fonts.ts` + `fontdata.generated.ts` +
`scripts/embed-fonts.mjs`, "PORT WITH CHANGES … swap the font set for 02 §7's
tokens"). Playfair Display and Inter are variable fonts upstream and remain
variable here; Bebas Neue is static.

## Subsetting

The committed `.subset.ttf` files are Latin-only subsets. Multi-language captions
are out of scope (00_MASTER §7), so a Latin subset is the entire requirement, and
it takes the three faces from 1.24MB to 200KB — which is the difference between a
reasonable vendored asset and a repo smell.

Produced with `fonttools` 4.63.0:

```
pyftsubset <upstream>.ttf --output-file=<name>.subset.ttf \
  --unicodes=U+0020-007E,U+00A0-00FF,U+2018-201D,U+2013,U+2014,U+2026,U+2022,U+20B9,U+20AC,U+2122,U+00AE \
  --layout-features=kern,liga,calt --no-hinting --desubroutinize \
  --drop-tables+=DSIG --name-IDs='*'
```

`--name-IDs='*'` is deliberate: it keeps the name table, and with it the copyright
(ID 0) and licence (ID 13/14) records, inside the binary. A subset that drops its
own licence record is an OFL problem waiting to happen.

**Adding a language means re-subsetting**, not editing `fontdata.generated.ts`.
Regenerate with `node packages/render/scripts/embed-fonts.mjs`.

## OFL compliance notes

- The OFL permits modification (subsetting is a modification) and redistribution
  bundled with other software, provided the licence travels with it — `OFL.txt`
  and this file are that.
- None of the three carries a Reserved Font Name we rename around: Playfair
  Display reserves its name, and we neither rename the family nor ship it under a
  different one, which is the permitted case.
- The subsets are **not** renamed, so a viewer inspecting the render's fonts sees
  the true family names.
