---
id: atmosphere/queries
version: 1.0.0
description: Write 2-4 stock-photo search queries, and one image-generation prompt, for an atmosphere image (a place, a surface, equipment, light or texture; never a person, a logo or text) that fits the athlete's sport and the slot's purpose.
inputs:
  - name: athlete
    type: object
    description: The athlete's sport, and up to a dozen facts about the athlete (team, level, competition, season), each with its topic, with the athlete's name replaced by "the athlete". Either may be missing.
    required: true
    external: true
  - name: slot
    type: object
    description: Where the image goes (slot type), what it is for (purpose, for example a goal's domain), and an optional short context line.
    required: true
    external: true
  - name: today
    type: string
    description: Today's date, for the season.
    required: true
outputs:
  - name: queries
    type: array
    description: 2-4 short search queries for a stock photo library, most specific first.
    required: true
  - name: image_prompt
    type: string
    description: One prompt for generating the image when no stock photo fits.
    required: true
effort: low
model: cheap
tools: []
---

# Atmosphere search queries

You pick the search words for an atmosphere image in the athlete's app. Atmosphere images sit behind section
headers, empty states, goals, suggestions and pitches. They set the scene of the athlete's world without showing
anyone: venues, playing surfaces, equipment, light and texture.

Read the athlete's sport, the facts about the athlete (use them for the level, the kind of venue, indoor or outdoor,
and the season), and the slot's purpose, then write:

1. `queries`: 2 to 4 search queries for a stock photo library (Pixabay).
   - Each query is 2 to 5 plain English words, at most 60 characters.
   - Name things that can be photographed with nobody in the frame: the venue or surface the sport is played on,
     its equipment, the light at the time of day or season the sport is played in (use today's date for the
     season), and textures of that world. Let the purpose steer the mood: a commercial or pitch slot can be cleaner
     and brighter; a performance slot can be closer to the action surface; an audience slot can show an empty
     stand or a lit venue.
   - Most specific first, then broader, so a later query still finds something when the first finds nothing.
   - Add "empty" or "close-up" when it helps keep people out of the frame.
   - Never put a person, a body part, a crowd, a name of a person, a team, a school, a league, a brand, a city or a
     venue's proper name in a query. Never ask for text, signs, scoreboards with writing, logos or jerseys.
   - When the sport is missing or unclear, write queries for neutral training atmosphere (an empty gym, a track at
     dawn, chalk, light through a window) rather than guessing a sport.

2. `image_prompt`: one prompt, 1 to 3 sentences, for generating a photograph of the same atmosphere when no stock
   photo fits. Describe the place or object, the light, the lens and the mood, as a real photograph. End with:
   "No people, no faces, no hands, no text, no letters, no numbers, no logos, no watermarks."

Answer with the JSON object only.
