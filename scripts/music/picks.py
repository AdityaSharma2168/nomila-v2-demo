INC = """Rhinoceros|Exhilarate|Ready Aim Fire|Unity|Urban Gauntlet|Voltaic|Super Power Cool Dude|Who Likes to Party|
Nonstop|Exit the Premises|Twisted|Highlight Reel|Eighties Action|Shiny Tech|Fearless First|Motivator|
Level Up|Pulse|Mandeville|
Werq|Getting it Done|Funky Chunk|Nowhere Land|Life of Riley|Disco Medusae|
Glitter Blast|Digital Lemonade|Funin and Sunin|
Too Cool|Chill Wave|Eternity|Miami Viceroy|Bummin on Tremelo|Newer Wave|
Dreamer|Late Night Radio|Dream Culture|
Americana|Neon Laser Horizon|Angel Share|Carefree|Montauk Point"""
INC = [t.strip() for t in INC.replace('\n','').split('|') if t.strip()]
FMA = {
 'rock-montage': ['Grunge','Jams','Punk','Americana','Classic'],
 'power-pop': ['Funky Pop','Happy Dance','Retro Synths','50 Over The Speed Limit','Bouncing','Back In The 80s','Mutant Club','Love Love Love'],
 'gamer-beats': ['Final Level','Hard Mode','Legends'],
 'phonk-aura-farming': ['Pantheon','Phonk ish'],
 'lazy-summer-lofi-1': ['Windows Down.mp3','Blue Skies.mp3'],
 'summer-air-lo-fi': ['Roof Tops','August Never Lasts'],
 'city-slacker': ['Busking In the SunLight','Hooptie With The Windows Down','Moving Forward','Endless Grind','Fresh Fit'],
 'waves-of-nostalgia-2': ['Night Life','All The Fight Left','New Gods','Street Lights Passing By'],
 'interstellar-pop-songs': ['Mars','Venus','Jupiter'],
 'be-happy-with-who-you-are': ['The Good Times','City Lights','Finding Yourself'],
 'bassic': ['Make Funk','Make Money'],
 'public-domain-lofi': ['Bubbles ( Lofi , Bright , Relaxed )','Projector Screen ( LoFi , Happy ).mp3','Canon Event ( Lofi , Sad , Reflection )'],
 'spring-at-last-lofi-tape': ['Spring At Last','Sense Of Purpose'],
}
