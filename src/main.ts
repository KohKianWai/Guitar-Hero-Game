/**
 * Inside this file you will use the classes and functions from rx.js
 * to add visuals to the svg element in index.html, animate them, and make them interactive.
 *
 * Study and complete the tasks in observable exercises first to get ideas.
 *
 * Course Notes showing Asteroids in FRP: https://tgdwyer.github.io/asteroids/
 *
 * You will be marked on your functional programming style
 * as well as the functionality that you implement.
 *
 * Document your code!
 */

import "./style.css";

import {
    fromEvent,
    interval,
    merge,
    from,
    of,
    Subject,
    Observable,
    zip,
} from "rxjs";
import { map, filter, scan, mergeMap, take, delay } from "rxjs/operators";
import * as Tone from "tone";
import { SampleLibrary } from "./tonejs-instruments";
import { TickParam } from "tone/build/esm/core/clock/TickParam";

/** Constants */

const Viewport = {
    CANVAS_WIDTH: 200,
    CANVAS_HEIGHT: 400,
} as const;

const Constants = {
    TICK_RATE_MS: 20,
    SECOND_PER_TICK: 0.02,
    SONG_NAME: "RockinRobin",
    INSTRUMENT: [
        "bass-electric",
        "piano",
        "trumpet",
        "saxophone",
        "trombone",
        "flute",
        "violin",
    ],
    MAX_VELOCITY: 127,
    MAX_PITCH: 127,
} as const;

const NoteConstants = {
    RADIUS: 0.07 * Viewport.CANVAS_WIDTH,
    TAIL_WIDTH: 10,
    NOTE_PATH_LENGTH: 350,
    NOTE_TRAVEL_DURATION: 2000, // 2 seconds
    NOTE_ALIGNMENT_TOLERANCE: 30,
} as const;

/** Type */

type Key = "KeyH" | "KeyJ" | "KeyK" | "KeyL";

type Event = "keydown" | "keyup" | "keypress";

type Note = Readonly<{
    id: string;
    createTime: number;
    userPlayed: boolean;
    instrumentName: string;
    velocity: number;
    pitch: number;
    start: number;
    end: number;
    cx: string;
    cy: number;
    tail: Tail | null;
}>;

type Tail = Readonly<{
    id: string;
    createTime: number;
    width: number;
    height: number;
    x: string;
    y: number;
    duration: number;
    style: string;
}>;

type State = Readonly<{
    time: number;
    gameEnd: boolean;
    note: ReadonlyArray<Note>;
    tail: ReadonlyArray<Tail>;
    exit: ReadonlyArray<Note | Tail>;
    noteCount: number;
    score: number;
    playNote: ReadonlyArray<Note>;
    backgroundNote: ReadonlyArray<Note>;
    randomNotes: ReadonlyArray<Note>;
    consecutiveHits: number;
    multiplier: number;
}>;

/** Utility functions */

/**
 * A random number generator which provides two pure functions
 * `hash` and `scaleToRange`.  Call `hash` repeatedly to generate the
 * sequence of hashes.
 * Cite: Applied 4 Exercise 1 and 2
 */
abstract class RNG {
    // LCG using GCC's constants
    private static m = 0x80000000; // 2**31
    private static a = 1103515245;
    private static c = 12345;

    /**
     * Call `hash` repeatedly to generate the sequence of hashes.
     * @param seed
     * @returns a hash of the seed
     */
    public static hash = (seed: number) => (RNG.a * seed + RNG.c) % RNG.m;

    /**
     * Takes hash value and scales it to the range [0, 1]
     */
    public static scale = (hash: number) => hash / (RNG.m - 1);
}

/**
 * Converts values in a stream to random numbers in the range [0, 1]
 * Cite: Applied 4 Exercise 1 and 2
 *
 * @param source$ The source Observable, elements of this are replaced with random numbers
 * @param seed The seed for the random number generator
 */
export function createRngStreamFromSource<T>(source$: Observable<T>) {
    return function createRngStream(seed: number = 0): Observable<number> {
        const randomNumberStream = source$.pipe(
            scan((acc) => RNG.hash(acc), seed),
            map((x) => RNG.scale(x)),
        );

        return randomNumberStream;
    };
}

/**
 * Assigning the column for each note using pitch % 4
 * @param pitch Music note pitch
 * @returns the column number
 */
const assignColumn = (pitch: number): number => {
    return pitch % 4;
};

/**
 * Calculate the movement per tick of the SVG element
 * @returns the movement per tick
 */
const movementPerTick = (): number => {
    return (
        NoteConstants.NOTE_PATH_LENGTH /
        (NoteConstants.NOTE_TRAVEL_DURATION / Constants.TICK_RATE_MS)
    );
};

/**
 * Calculate the tail length
 * @param noteDuration The duration of the music note
 * @returns the tail length
 */
const tailLength = (noteDuration: number): number => {
    return (
        (NoteConstants.NOTE_PATH_LENGTH / NoteConstants.NOTE_TRAVEL_DURATION) *
        (noteDuration * 1000)
    );
};

/**
 * Curried function to check if a note is aligned within a tolerance
 * @param tolerance Tolerance
 * @param targetCy The target y position
 * @param note The music note
 * @returns a boolean value to check if a note is aligned within a tolerance
 */
const isAlignedCurried =
    (tolerance: number) =>
    (targetCy: number) =>
    (note: Note): boolean => {
        return Math.abs(note.cy - targetCy) <= tolerance;
    };

/**
 * Applying the curried function with a specific tolerance and targetCy
 */
const isAligned = isAlignedCurried(NoteConstants.NOTE_ALIGNMENT_TOLERANCE)(
    NoteConstants.NOTE_PATH_LENGTH,
);

/** Main function */

/**
 * This is the function called on page load. Your main game loop
 * should be called here.
 */
export function main(
    csvContents: string,
    samples: { [key: string]: Tone.Sampler },
) {
    // Canvas elements
    const svg = document.querySelector("#svgCanvas") as SVGGraphicsElement &
        HTMLElement;
    const preview = document.querySelector(
        "#svgPreview",
    ) as SVGGraphicsElement & HTMLElement;
    const gameover = document.querySelector("#gameOver") as SVGGraphicsElement &
        HTMLElement;
    const container = document.querySelector("#main") as HTMLElement;

    svg.setAttribute("height", `${Viewport.CANVAS_HEIGHT}`);
    svg.setAttribute("width", `${Viewport.CANVAS_WIDTH}`);

    // Text fields
    const multiplier = document.querySelector("#multiplierText") as HTMLElement;
    const scoreText = document.querySelector("#scoreText") as HTMLElement;
    const highScoreText = document.querySelector(
        "#highScoreText",
    ) as HTMLElement;
    const streak = document.querySelector("#streak") as HTMLElement;

    /** Classes */

    // Define classes for different event
    class Tick {
        constructor(public readonly elapsed: number) {}
    }

    class MusicNote {
        constructor(public readonly note: Note) {}
    }

    class KeyPressEvent {
        constructor(public readonly column: number) {}
    }

    class BackgroundNote {
        constructor(public readonly note: Note) {}
    }

    class EndTail {
        constructor(public readonly endTime: number) {}
    }

    const initialState: State = {
        time: 0,
        gameEnd: false,
        note: [],
        tail: [],
        exit: [],
        noteCount: 0,
        score: 0,
        playNote: [],
        backgroundNote: [], // Create this to ensure the quality of music played is good
        randomNotes: [],
        consecutiveHits: 0,
        multiplier: 1,
    } as const;

    /** State processing */

    /**
     * Updates the state by proceeding with one time step.
     *
     * @param s Current state
     * @param elapsed Time elapsed
     * @returns Updated state
     */
    const tick = (s: State, elapsed: number): State => {
        // Negates the result of the provided function
        const not =
            <T>(f: (x: T) => boolean) =>
            (x: T) =>
                !f(x);

        // Determine if a note or tail has expired
        // Note after 100 ticks will expire
        const noteExpired = (note: Note): boolean =>
            elapsed - note.createTime >
            NoteConstants.NOTE_TRAVEL_DURATION /
                1000 /
                Constants.SECOND_PER_TICK;

        // Ensure the tail is removed after it finished its movement
        const tailExpired = (tail: Tail): boolean =>
            elapsed - tail.createTime >
            (tail.duration * 5) / Constants.SECOND_PER_TICK;

        // Filter out expired and active notes or tails
        const expiredNote: Note[] = s.note.filter(noteExpired);
        const activeNote: Note[] = s.note.filter(not(noteExpired));

        const expiredTail: Tail[] = s.tail.filter(tailExpired);
        const activeTail: Tail[] = s.tail.filter(not(tailExpired));

        // Check if any expired notes are not in playNote
        // Filter out the note with tail to ensure the note will tail will not affect the calculation of score
        const missedNotes = expiredNote
            .filter((note) => !s.playNote.includes(note))
            .filter((note) => !note.tail);

        // Update the positions of active notes, check for expired notes
        // Reset the associated array
        return {
            ...s,
            note: activeNote.map(moveNote),
            tail: activeTail.map(moveTail),
            exit: [...expiredNote, ...expiredTail],
            time: elapsed,
            playNote: [],
            backgroundNote: [],
            randomNotes: [],
            consecutiveHits: missedNotes.length > 0 ? 0 : s.consecutiveHits, // Reset hit streak on miss
            multiplier: missedNotes.length > 0 ? 1 : s.multiplier, // Reset multiplier on miss
        };
    };

    /**
     * Function to reduce the state based on different event types
     * @param s Current state
     * @param e Class instances
     * @returns Updated state
     */
    const reduceState = (
        s: State,
        e: MusicNote | Tick | KeyPressEvent | BackgroundNote | EndTail | Number,
    ): State => {
        if (e instanceof MusicNote) {
            const newNote = createNote(s, e);

            if (newNote.tail) {
                // If the note has tail
                return {
                    ...s,
                    note: s.note.concat([newNote]), // Add new note to game state
                    noteCount: s.noteCount + 1,
                    tail: s.tail.concat([newNote.tail]), // Add the new tail to game state
                };
            } else {
                // If the note has no tail
                return {
                    ...s,
                    note: s.note.concat([newNote]),
                    noteCount: s.noteCount + 1,
                };
            }
        } else if (e instanceof KeyPressEvent) {
            return processNoteEvent(s, e);
        } else if (e instanceof BackgroundNote) {
            return {
                ...s,
                // Assign the playNote a new array of background notes
                playNote: s.backgroundNote.concat([createNote(s, e)]),
            };
        } else if (e instanceof Tick) {
            return tick(s, e.elapsed);
        } else if (e instanceof EndTail) {
            return processNoteEvent(s, e);
        } else {
            // End the game
            return {
                ...s,
                gameEnd: true,
            };
        }
    };

    /**
     * Processes the game state based on a KeyPressEvent or EndTail event
     * @param s the current state
     * @param e the event trigger the state change
     * @returns updated state
     */
    function processNoteEvent(s: State, e: KeyPressEvent | EndTail): State {
        if (e instanceof KeyPressEvent) {
            // Find the closest note in a specific column
            const activeNote = s.note.find(
                (note) => assignColumn(note.pitch) === e.column,
            );

            if (activeNote) {
                // Check alignment using position
                if (isAligned(activeNote)) {
                    // Only update the score immediately when the note has no tail
                    // otherwise the score will only update when the tail is processed
                    if (!activeNote.tail) {
                        const { newStreak, roundedMultiplier, roundedScore } =
                            calculateMultiplierAndScore(s);

                        return {
                            ...s,
                            note: s.note.filter((note) => note !== activeNote), // Remove played note from active notes
                            exit: s.exit.concat([activeNote]), // Remove the note when the note is played
                            score: roundedScore,
                            playNote: s.playNote.concat([activeNote]), // Add played note to array to play the sound
                            consecutiveHits: newStreak,
                            multiplier: roundedMultiplier,
                        };
                    } else {
                        // Score will not be processed at the very first for tail notes
                        return {
                            ...s,
                            note: s.note.filter((note) => note !== activeNote),
                            exit: s.exit.concat([activeNote]),
                            playNote: s.playNote.concat([activeNote]),
                        };
                    }
                } else {
                    // If the note is not aligned, concate a dummy note into the randomNotes array
                    // The dummy notes is just to count the number of times the user press wrongly
                    return {
                        ...s,
                        randomNotes: s.randomNotes.concat([createNote(s, e)]),
                    };
                }
            } else {
                // If no active note in the column, concate a dummy note into the randomNotes array
                return {
                    ...s,
                    randomNotes: s.randomNotes.concat([createNote(s, e)]),
                };
            }
        } else {
            // If the note has tail, score is calculated here
            // Check alignment using time elapsed
            // Check is the tail is hold completely (with tolerance)
            const isTailAlign =
                Math.abs(
                    s.time * Constants.SECOND_PER_TICK -
                        e.endTime -
                        NoteConstants.NOTE_TRAVEL_DURATION / 1000,
                ) <= 0.25; // Set tolerance to 0.25s
            if (isTailAlign) {
                const { newStreak, roundedMultiplier, roundedScore } =
                    calculateMultiplierAndScore(s);

                return {
                    ...s,
                    score: roundedScore,
                    consecutiveHits: newStreak,
                    multiplier: roundedMultiplier,
                };
            } else {
                // Reset the streak and multiplier if the tail is not align
                return {
                    ...s,
                    consecutiveHits: 0,
                    multiplier: 1,
                };
            }
        }
    }

    /**
     * Function to calculate multiplier and score
     * @param s the current state
     * @returns the new streak, multiplier and score
     */
    function calculateMultiplierAndScore(s: State): {
        newStreak: number;
        roundedMultiplier: number;
        roundedScore: number;
    } {
        // Increment the hit streak by 1 for a successful note hit.
        // If the new hit streak is a multiple of 10, increase the multiplier by 0.2;
        // otherwise, keep the current multiplier unchanged.
        const newStreak = s.consecutiveHits + 1;
        const newMultiplier =
            newStreak % 10 === 0 ? s.multiplier + 0.2 : s.multiplier;

        // Due to small precision error of binary representation of Javascript,
        // we have to round the multiplier to avoid floating point number issue.
        // Cite: Suggested by Chatgpt
        const roundedMultiplier = Math.round(newMultiplier * 10) / 10;
        const roundedScore =
            Math.round((s.score + 1 * roundedMultiplier) * 10) / 10;

        return {
            newStreak,
            roundedMultiplier,
            roundedScore,
        };
    }

    /**
     * Function to create a music note
     * @param s The current state
     * @param e The music note's class
     * @returns a new music note
     */
    function createNote(
        s: State,
        e: MusicNote | BackgroundNote | KeyPressEvent,
    ): Note {
        if (e instanceof KeyPressEvent) {
            // Return the dummy note for counting purpose
            return {
                id: "",
                createTime: 0,
                userPlayed: true,
                instrumentName: "piano",
                velocity: 0,
                pitch: 0,
                start: 0,
                end: 0,
                cx: ``,
                cy: 0,
                tail: null,
            };
        } else {
            return {
                id: e instanceof MusicNote ? `note${s.noteCount}` : "",
                createTime: s.time,
                userPlayed: e.note.userPlayed,
                instrumentName: e.note.instrumentName,
                velocity: e.note.velocity,
                pitch: e.note.pitch,
                start: e.note.start,
                end: e.note.end,
                cx: e.note.cx,
                cy: 0,
                tail: e.note.end - e.note.start >= 1 ? createTail(s, e) : null, // Check if the note has tail
            };
        }
    }

    /**
     * Function to create a tail
     * @param s The current state
     * @param e The music note's class
     * @returns a new note tail
     */
    function createTail(s: State, e: MusicNote): Tail {
        const tailDistance = tailLength(e.note.end - e.note.start);
        return {
            id: `Tail${s.noteCount}`,
            createTime: s.time,
            width: NoteConstants.TAIL_WIDTH,
            height: tailDistance,
            x: `${[35, 75, 115, 155][assignColumn(e.note.pitch)]}`, // Set the column by pitch
            // Set initial starting point outside the SVG to ensure a smooth entry into visible area of SVG
            y: -1 * tailDistance,
            duration: e.note.end - e.note.start,
            style: `fill: ${["green", "red", "blue", "yellow"][assignColumn(e.note.pitch)]}`,
        };
    }

    /**
     * Function to move the note by updating its 'cy' position (1 tick)
     * @param note Music note
     * @returns Updated music note
     */
    const moveNote = (note: Note): Note => {
        return {
            ...note,
            cy: note.cy + movementPerTick(),
        };
    };

    /**
     * Function to move the tail by updating its 'y' and 'height' (1 tick)
     * @param tail Music note's tail
     * @returns Updated music note's tail
     */
    const moveTail = (tail: Tail): Tail => {
        if (tail.y + tail.height >= NoteConstants.NOTE_PATH_LENGTH) {
            // We set the new height of the tail when it reaches the bottom
            // to create a visually accurate shrinking effect
            const newHeight = Math.max(0, tail.height - movementPerTick());
            return {
                ...tail,
                height: newHeight,
                y: NoteConstants.NOTE_PATH_LENGTH - newHeight,
            };
        } else {
            return {
                ...tail,
                y: tail.y + movementPerTick(),
            };
        }
    };

    /** Play instrument sound */

    /**
     * Function to play an instrument using the given note's properties
     * @param note The music note to play
     */
    function playInstrument(note: Note): void {
        if (note.tail) {
            // If notes have tail
            // Trigger the sound for notes until the user release
            samples[note.instrumentName].triggerAttack(
                Tone.Frequency(note.pitch, "midi").toNote(),
                undefined,
                note.velocity,
            );

            // Observable that listens for the key release event corresponding to the column
            const keyUpStream$ = keyUp$.pipe(
                filter((number) => number === assignColumn(note.pitch)),
                map(() => "keyUp"),
                take(1),
            );

            // Observable that waits for the duration of the note to elapse
            const duration$ = interval((note.end - note.start) * 1000).pipe(
                map(() => "finish"),
                take(1),
            );

            // Merge the key release and duration observables to determine which happens first
            // take(1) determine which happens first (user release / note duration)
            merge(keyUpStream$, duration$)
                .pipe(take(1))
                .subscribe((value) => {
                    if (value === "keyUp") {
                        // Notify that the tail has ended on a key release
                        tailSubject$.next(note.end);
                    }
                    // Stop the sound
                    samples[note.instrumentName].triggerRelease(
                        Tone.Frequency(note.pitch, "midi").toNote(),
                    );
                });
        } else {
            // Play the duration if the notes has no tail
            samples[note.instrumentName].triggerAttackRelease(
                Tone.Frequency(note.pitch, "midi").toNote(),
                note.end - note.start,
                undefined,
                note.velocity,
            );
        }
    }

    /**
     * Function to play a random note
     */
    function playRandomNote(): void {
        // Emit a value to the subject, which can trigger the playing of a random note
        randomSubject$.next();
    }

    /** Parsing notes from CSV */

    // Split the CSV contents by lines and skip the header and take the game end time
    const textLine = csvContents.trim().split("\n").slice(1);
    const gameEndTime = textLine[textLine.length - 1].split(",")[5];

    // Create an observable of notes
    const note$ = from(textLine).pipe(
        map((line) => {
            // Destructure the CSV line into its components
            const [userPlayed, instrumentName, velocity, pitch, start, end] =
                line.split(",");
            // Return a Note object
            return {
                id: "",
                createTime: 0,
                userPlayed: userPlayed === "True",
                instrumentName: instrumentName,
                // Scale the velocity to [0,1]
                velocity: Number(velocity) / Constants.MAX_VELOCITY,
                pitch: Number(pitch),
                start: Number(start),
                end: Number(end),
                // Assign the x position (column) using pitch
                cx: `${["20%", "40%", "60%", "80%"][assignColumn(Number(pitch))]}`,
                cy: 0,
                tail: null,
            };
        }),
        mergeMap((note) => {
            // Delay emission based on the note's start time
            return of(note).pipe(delay(note.start * 1000));
        }),
    );

    // Observable of notes where userPlayed is false, converting them into BackgroundNote instances
    const noteFalse$ = note$.pipe(
        filter(({ userPlayed }) => !userPlayed),
        // Delay for purpose to start at the same time when the notes moved to the bottom
        delay(NoteConstants.NOTE_TRAVEL_DURATION),
        map((note) => new BackgroundNote(note)),
    );

    // Observable of notes where userPlayed is true, converting them into MusicNote instances
    const noteTrue$ = note$.pipe(
        filter(({ userPlayed }) => userPlayed),
        map((note) => new MusicNote(note)),
    );

    // Create an observable to emit value when the game end to stop the game
    const gameEndNotifier$ = of(new Number(gameEndTime)).pipe(
        delay(Number(gameEndTime) * 1000 + NoteConstants.NOTE_TRAVEL_DURATION),
    );

    /** Random Note Generator */

    // Create an observable that handle random
    const randomSubject$ = new Subject<void>();

    // Create an observable of random value
    const rngStream$ = createRngStreamFromSource(randomSubject$);

    zip(rngStream$(100), rngStream$(1), rngStream$(2), rngStream$(3))
        .pipe(
            map(([value1, value2, value3, value4]) => {
                return {
                    id: "",
                    createTime: 0,
                    userPlayed: false,
                    instrumentName:
                        Constants.INSTRUMENT[
                            Math.round(
                                value1 * (Constants.INSTRUMENT.length - 1),
                            )
                        ],
                    velocity: 0.3 * value2 + 0.5, // Scale the volume to [0.5, 0.8]
                    pitch: Math.round(value3 * 90), // Scale the pitch to [0, 90]
                    start: 0,
                    end: value4 * 0.5,
                    cx: "",
                    cy: 0,
                    tail: null,
                };
            }),
        )
        .subscribe(playInstrument);

    /** Create a notifier to track the tail end time */

    const tailSubject$ = new Subject<number>();
    const tailEndNotifier$ = tailSubject$.pipe(
        map((endTime) => new EndTail(endTime)),
    );

    /** User input */

    // Reusable function to create observable for specific event
    const keyObservable$ = (
        event: Event,
        key: Key,
        changeState: { column: number },
    ): Observable<{
        column: number;
    }> => {
        return fromEvent<KeyboardEvent>(document, event).pipe(
            filter(({ code }) => code === key),
            filter(({ repeat }) => !repeat),
            map(() => changeState),
        );
    };

    // Create observables for each key up and key down event
    const keyDownH$ = keyObservable$("keydown", "KeyH", { column: 0 });
    const keyDownJ$ = keyObservable$("keydown", "KeyJ", { column: 1 });
    const keyDownK$ = keyObservable$("keydown", "KeyK", { column: 2 });
    const keyDownL$ = keyObservable$("keydown", "KeyL", { column: 3 });

    const keyUpH$ = keyObservable$("keyup", "KeyH", { column: 0 });
    const keyUpJ$ = keyObservable$("keyup", "KeyJ", { column: 1 });
    const keyUpK$ = keyObservable$("keyup", "KeyK", { column: 2 });
    const keyUpL$ = keyObservable$("keyup", "KeyL", { column: 3 });

    // Combine all key observables into one observable stream
    const keyDown$ = merge(keyDownH$, keyDownJ$, keyDownK$, keyDownL$).pipe(
        map((key) => new KeyPressEvent(key.column)), // Map the result to a KeyPressEvent instance
    );

    const keyUp$ = merge(keyUpH$, keyUpJ$, keyUpK$, keyUpL$).pipe(
        map((key) => key.column),
    );

    /** Determines the rate of time steps */

    const tick$ = interval(Constants.TICK_RATE_MS);
    const gameClock$ = tick$.pipe(map((elapsed) => new Tick(elapsed)));

    /** Rendering (side effects) */

    /**
     * Renders the current state to the canvas.
     *
     * In MVC terms, this updates the View using the Model.
     *
     * @param s Current state
     */
    const render = (s: State): void => {
        /**
         * Displays a SVG element on the canvas. Brings to foreground.
         * @param elem SVG element to display
         */
        const show = (elem: SVGGraphicsElement): void => {
            elem.setAttribute("visibility", "visible");
            elem.parentNode!.appendChild(elem);
        };

        /**
         * Hides a SVG element on the canvas.
         * @param elem SVG element to hide
         */
        const hide = (elem: SVGGraphicsElement): void =>
            elem.setAttribute("visibility", "hidden");

        /**
         * Creates an SVG element with the given properties.
         *
         * See https://developer.mozilla.org/en-US/docs/Web/SVG/Element for valid
         * element names and properties.
         *
         * @param namespace Namespace of the SVG element
         * @param name SVGElement name
         * @param props Properties to set on the SVG element
         * @returns SVG element
         */
        const createSvgElement = (
            namespace: string | null,
            name: string,
            props: Record<string, string> = {},
        ): SVGElement => {
            const elem = document.createElementNS(
                namespace,
                name,
            ) as SVGElement;
            Object.entries(props).forEach(([k, v]) => elem.setAttribute(k, v));
            return elem;
        };

        // Create/Set the movement of notes
        s.note.forEach((note) => {
            const initialiseCircle = () => {
                const circle = createSvgElement(svg.namespaceURI, "circle", {
                    r: `${NoteConstants.RADIUS}`,
                    style: `fill: ${["green", "red", "blue", "yellow"][assignColumn(note.pitch)]}`,
                    class: "shadow",
                    id: note.id,
                    cx: note.cx,
                });
                svg.appendChild(circle);
                return circle;
            };

            const circle =
                document.getElementById(note.id) || initialiseCircle();
            circle.setAttribute("cy", String(note.cy));
        });

        // Create/Set the movement of tail
        s.tail.forEach((tail) => {
            const initialiseTail = () => {
                const rect = createSvgElement(svg.namespaceURI, "rect", {
                    style: `${tail.style};stroke-width:0`,
                    id: tail.id,
                    width: String(tail.width),
                    x: tail.x,
                });
                svg.appendChild(rect);
                return rect;
            };

            const rect = document.getElementById(tail.id) || initialiseTail();
            rect.setAttribute("y", String(tail.y));
            rect.setAttribute("height", String(tail.height));
        });

        // Remove the element from the SVG
        s.exit.forEach((elem) => {
            const element = document.getElementById(elem.id);
            if (element) svg.removeChild(element);
        });

        // Play the music of the note
        s.playNote.forEach(playInstrument);
        s.randomNotes.forEach((_) => playRandomNote());

        // Set the score, multiplier and streak
        scoreText.innerText = `${s.score}`;
        multiplier.innerText = `${s.multiplier}x`;
        streak.innerText = `${s.consecutiveHits}`;

        // Unsubscribe the main game stream and show "Game Over" when game is end
        if (s.gameEnd) {
            source$.unsubscribe();
            show(gameover);
        } else {
            hide(gameover);
        }
    };

    /** Main game stream */

    const source$ = merge(
        gameClock$,
        noteTrue$,
        keyDown$,
        noteFalse$,
        gameEndNotifier$,
        tailEndNotifier$,
    )
        .pipe(scan(reduceState, initialState))
        .subscribe(render);
}

// The following simply runs your main function on window load.  Make sure to leave it in place.
// You should not need to change this, beware if you are.
if (typeof window !== "undefined") {
    // Load in the instruments and then start your game!
    const samples = SampleLibrary.load({
        instruments: [
            "bass-electric",
            "violin",
            "piano",
            "trumpet",
            "saxophone",
            "trombone",
            "flute",
        ], // SampleLibrary.list,
        baseUrl: "samples/",
    });

    const startGame = (contents: string) => {
        document.body.addEventListener(
            "mousedown",
            function () {
                main(contents, samples);
            },
            { once: true },
        );
    };

    const { protocol, hostname, port } = new URL(import.meta.url);
    const baseUrl = `${protocol}//${hostname}${port ? `:${port}` : ""}`;

    Tone.ToneAudioBuffer.loaded().then(() => {
        for (const instrument in samples) {
            samples[instrument].toDestination();
            samples[instrument].release = 0.5;
        }

        fetch(`${baseUrl}/assets/${Constants.SONG_NAME}.csv`)
            .then((response) => response.text())
            .then((text) => startGame(text))
            .catch((error) =>
                console.error("Error fetching the CSV file:", error),
            );
    });
}
