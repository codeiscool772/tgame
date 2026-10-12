const TEMPLATE_SOURCE = String.raw`@format 3
@title My Game
@author Your Name
@start start

// ─────────────────────────────────────────────────────────────
// Welcome to tgame studio — format 3.
//
//     :: name              start a passage (a place)
//     plain text           narration; consecutive lines form a paragraph
//     (blank line)         new paragraph
//     * Label -> target    a choice that jumps to another passage
//     * Label [effect]     a choice that stays in place
//     * Label [once]       a choice that disappears after it is taken
//     ? question [var]     ask the player a question
//     ...                  pause half a second (or: ... 800, ... 2s)
//     ~type / ~normal      toggle the typewriter effect
//     [get X] [drop X]     inventory
//     if has X: ... end    check inventory
//     >> name              run another passage in place (a snippet)
//     @set x = 0           declare a variable
//     @list clues          declare a list
//     {variable}           insert a value into text
//     \-> or \*            escape: render as literal text
//
// Press ? for the full reference, or open an Example from the
// activity rail on the left to see a finished game.
// ─────────────────────────────────────────────────────────────

@set score = 0

:: start
Replace this line with your opening paragraph.

* Go somewhere -> somewhere
* Finish here -> END

:: somewhere
You went somewhere. Congratulations!

Your score is {score}.

* Back to the start -> start
* Finish -> END
`;

