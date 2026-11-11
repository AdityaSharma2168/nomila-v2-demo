---
id: atmosphere/check
version: 1.0.0
description: Look at one candidate atmosphere image and say whether it shows any person, face, logo, text or watermark, and whether it fits the slot's purpose. Code accepts the image only when every answer is clean.
inputs:
  - name: image
    type: string
    description: The candidate image.
    required: true
  - name: slot
    type: object
    description: The slot type and purpose the image is for, and the search query that found it.
    required: true
    external: true
outputs:
  - name: person
    type: boolean
    description: Any person or part of a person is visible, however small, blurred or distant (a silhouette, a hand, a crowd, a reflection).
    required: true
  - name: face
    type: boolean
    description: Any face is visible, human or drawn.
    required: true
  - name: logo
    type: boolean
    description: Any logo, brand mark, crest or trademark is visible.
    required: true
  - name: text
    type: boolean
    description: Any readable or partly readable letters or numbers are visible (signs, scoreboards, jersey numbers, captions).
    required: true
  - name: watermark
    type: boolean
    description: Any watermark, stamp or overlay is visible.
    required: true
  - name: fits_purpose
    type: boolean
    description: The image is a clean, well-made atmosphere photograph (a place, a surface, equipment, light or texture) that fits the slot's purpose and the sport world in the query.
    required: true
  - name: reason
    type: string
    description: One short sentence saying what is in the image and why it passes or fails.
    required: true
effort: low
model: cheap
tools: []
---

# Atmosphere image check

You are the last check before a stock or generated photograph is stored as an atmosphere image in an athlete's
app. Atmosphere images must never show a person, a logo or text. Be strict: when you are unsure, answer true for
the problem.

Look at the image and answer each field:

- `person`: true if any person or part of a person is visible anywhere: a figure, a silhouette, a hand, a foot, a
  crowd in the background, a reflection, a shadow that is clearly a person. Mannequins and statues count.
- `face`: true if any face is visible, including drawn, printed or on a screen.
- `logo`: true if any logo, brand mark, team crest, trademark or recognisable product branding is visible.
- `text`: true if any letters or numbers are visible, even partly: signs, banners, scoreboards, jersey or bib
  numbers, labels on equipment, captions.
- `watermark`: true if a watermark, stamp, border caption or overlay is visible.
- `fits_purpose`: true only if the image is a clean, well-made photograph of a place, a surface, equipment, light
  or texture that fits the slot's purpose and the world named in the query. False for a blurry, low-quality,
  cluttered or unrelated image, an illustration or a collage.
- `reason`: one short sentence: what is in the image, and the problem if there is one.

Answer with the JSON object only.
