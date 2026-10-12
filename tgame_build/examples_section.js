/* ═══════════════════════════════════════════════════════════════════
   EXAMPLES
   ═══════════════════════════════════════════════════════════════════ */
const FENCE = '```';
const EXAMPLES = {
  cave: {
    label: 'The Cave',
    hint: 'inventory + conditions',
    source: String.raw`@format 3
@title The Cave
@author You
@start entrance

@set score = 0

:: entrance
The cave mouth yawns open in the hillside.
Cold air spills out, smelling of wet stone.

if not has lamp:
A rusted brass lamp lies half-buried in the dirt.
* Take the lamp -> entrance [get lamp, score += 5]
end

* Go north into the cave -> dark_hall
* Walk back to the village -> village

:: dark_hall
if has lamp:
By the lamp's thin light you see a door to the east
and a low passage leading north.
* Open the door -> treasure
* Follow the passage -> deep
else:
It's pitch black in here. Something is breathing,
slowly, somewhere ahead of you.
* Retreat -> entrance
end

:: deep
The passage narrows and then stops entirely.
Something glitters in the rock at eye level.
* Pry it loose -> treasure [get gem, score += 50]
* Go back -> dark_hall

:: treasure
Gold. Actual gold, warm to the touch.
You are rich, and possibly cursed.

You are carrying {inventory}.
Your score: {score}
-> END

:: village
The village is warm and boring. You go home.

Your score: {score}
-> END
`
  },
  rock: {
    label: 'Magic Rock',
    hint: 'variables & conditions',
    source: String.raw`@format 3
@title The Magic Rock
@start beach

@set polished = false
@set score = 0

:: beach
You find a dull grey rock on the sand.

if polished:
The rock gleams faintly in the afternoon sun.
else:
It's just an ordinary rock. Boring, even.
end

* Polish the rock -> beach [polished = true, score += 1]
* Throw it in the sea -> sea
* Put it in your pocket -> pocket [get rock]

:: sea
You hurl the rock into the waves. It sinks immediately.
Somewhere, a fish is disappointed.

Score: {score}
-> END

:: pocket
You put the rock in your pocket. It is a good rock.

Score: {score}
-> END
`
  },
  counter: {
    label: 'Counter',
    hint: 'self-looping choices',
    source: String.raw`@format 3
@title Counter
@start start

@set n = 0
@set clicks = 0

:: start
The counter shows: {n}

You've pressed the button {clicks} {clicks == 1 | time | times}.

* Press the button [n += 1, clicks += 1]
* Reset [n = 0, clicks = 0]
* Stop -> END
`
  },
  name: {
    label: 'Your Name',
    hint: 'typed input (text / number)',
    source: String.raw`@format 3
@title Your Name
@start start

:: start
A robed figure sits at a desk. They look up.

? What is your name? [name:text] -> age

:: age
"Welcome, {name}."

? And how many winters have you seen? [winters:number] -> greeting

:: greeting
They hand you a key.
[get key]

if winters >= 60:
"A long road, {name}."
else:
"Young, still."
end

Your inventory: {inventory}.
-> END
`
  },
  mood: {
    label: 'Mood Piece',
    hint: 'pauses & typewriter',
    source: String.raw`@format 3
@title The Empty House
@start hall

@typewriter slow

:: hall
You push the door open. It swings inward without a sound.

...

The hallway is long and narrow. Dust hangs in the air,
lit by a single window at the far end.

...

~type
Somewhere in the house, a clock is ticking.
~normal

... 1500

Then it stops.

* Walk down the hall -> hall_end
* Leave -> END

:: hall_end
The hallway is much longer than it looked from the door.
-> END
`
  },
  parser: {
    label: 'Typed Commands',
    hint: 'parser mode, aliases, disambiguation',
    source: String.raw`@format 3
@title Parser Demo
@start hall
@parser
@ignore the a an

:: hall
A narrow hall. A DOOR is east, and a LAMP sits on a table.

* Look at the lamp | examine lamp, x lamp -> hall
* Take the lamp | get lamp, grab lamp -> hall [get lamp]
* Open the door | go east, east -> corridor

// Type "lamp" to see disambiguation. "help", "undo" and "save" work too.

:: corridor
You step through into a brighter corridor.

* Go back | west -> hall
* Continue -> END
`
  },
  tunnels: {
    label: 'Tunnels, Once & Paragraphs',
    hint: '>> snippets, once, enter, tags, verbatim',
    source: String.raw`@format 3
@title Tunnels and Once
@start gate

@set coins = 3
@list notes

// Consecutive lines form one paragraph. A blank line starts a new one.
// A line ending in a backslash is a hard line break.

:: gate #hub
The gate stands open. You have {coins} {coins == 1 | coin | coins}\
in your pocket.

>> weather

* Pick up the coin in the dirt -> gate [coins += 1, once]
* Read the sign -> sign
* Walk through -> END

// A passage called with >> is a snippet: text and effects only.
:: weather #snippet
{if coins > 3}The sun is out and the coins feel heavy.{else}Clouds gather over the gate.{end}

:: sign
[enter notes add sign]
[once coins += 1]
` + FENCE + String.raw`
   _____________
  |  WELCOME    |
  |  TRAVELLER  |
  |_____________|
` + FENCE + String.raw`

The sign is spotted with rust. Notes so far: {notes}.

* Back to the gate -> gate
`
  },
  hello: {
    label: 'Hello, World',
    hint: 'absolute minimum',
    source: String.raw`@format 3
@title Hello, World
@start start

:: start
Hello, world!

This is a tgame — a tiny interactive story.

* Say goodbye -> END
* Say hello again -> start
`
  }
};

function loadExample(key){
  const ex = EXAMPLES[key];
  if (!ex) return;
  if (!confirm('Load "' + ex.label + '"? Your current file will be replaced.')) return;
  applySource(ex.source);
  setFileName(key + '.tgame');
  scheduleLint();
  scheduleAutosave();
  runGame();
}

(function buildExamplesList(){
  const list = $('examples-list');
  const keys = Object.keys(EXAMPLES);
  for (let i = 0; i < keys.length; i++){
    const key = keys[i];
    const ex = EXAMPLES[key];
    const el = document.createElement('div');
    el.className = 'row example';
    el.innerHTML =
      '<span class="icon"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">' +
        '<path d="M4 12.5A2.5 2.5 0 0 1 6.5 10H13"/>' +
        '<path d="M6.5 2H13v12H6.5A2.5 2.5 0 0 1 4 11.5v-7A2.5 2.5 0 0 1 6.5 2z"/>' +
      '</svg></span>' +
      '<span class="body"><span class="label">' + esc(ex.label) + '</span>' +
      '<span class="desc">' + esc(ex.hint) + '</span></span>';
    el.onclick = (function(k){ return function(){ loadExample(k); }; })(key);
    list.appendChild(el);
  }
})();

