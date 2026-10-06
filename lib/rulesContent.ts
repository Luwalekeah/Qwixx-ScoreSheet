// Rules, strategy and probability content carried over from the old app's
// expander.py. The facts are unchanged. The copy is rewritten to the Luwah
// standard: no emoji, no em dashes, no arrows as punctuation, short active
// sentences.

export interface RuleList {
  heading?: string;
  items: string[];
}

export interface RuleSection {
  id: string;
  title: string;
  body: (string | RuleList)[];
}

export const SCORING_TABLE: Array<{ crosses: number; points: number }> = [
  { crosses: 1, points: 1 },
  { crosses: 2, points: 3 },
  { crosses: 3, points: 6 },
  { crosses: 4, points: 10 },
  { crosses: 5, points: 15 },
  { crosses: 6, points: 21 },
  { crosses: 7, points: 28 },
  { crosses: 8, points: 36 },
  { crosses: 9, points: 45 },
  { crosses: 10, points: 55 },
  { crosses: 11, points: 66 },
  { crosses: 12, points: 78 },
];

export const RULE_SECTIONS: RuleSection[] = [
  {
    id: 'overview',
    title: 'Game overview',
    body: [
      {
        items: [
          'Players 2 to 5. Ages 8 and up. About 15 minutes.',
          'Object: score the most points by crossing off numbers in the four coloured rows.',
          'Components: six dice, four coloured and two white, plus a score sheet for each player.',
          'Red and yellow run 2 to 12, left to right. Green and blue run 12 to 2, left to right.',
        ],
      },
    ],
  },
  {
    id: 'how-to-play',
    title: 'How to play',
    body: [
      {
        items: [
          'The active player rolls all six dice.',
          'Everyone may use the sum of the two white dice.',
          'The active player may also use one white die plus one coloured die.',
          'Cross off the matching number in the matching coloured row.',
          'Numbers must be crossed off left to right in each row. You may skip numbers. You cannot go back.',
          'You never have to cross anything off.',
          'If you cross nothing off on your own roll, mark a penalty. Four penalties ends the game at once.',
        ],
      },
    ],
  },
  {
    id: 'scoring',
    title: 'Scoring',
    body: [
      {
        items: [
          '1 crossed number scores 1. 2 score 3. 3 score 6. 4 score 10. 5 score 15. 6 score 21.',
          '7 score 28. 8 score 36. 9 score 45. 10 score 55. 11 score 66. 12 score 78.',
          'Each penalty costs 5 points.',
          'Final score is the four row scores added together, minus penalties.',
        ],
      },
    ],
  },
  {
    id: 'locking',
    title: 'Locking a row',
    body: [
      {
        items: [
          'To lock a row you must already have at least 5 numbers crossed off in it.',
          'You must then cross off the rightmost number of that row. That is 12 for red and yellow, and 2 for green and blue.',
          'You can only reach that number with a coloured die, not the white dice sum.',
          'The lock counts as one more crossed number when you score the row. Five crosses plus the rightmost number is six crosses, and the lock makes seven, which scores 28.',
          'Locking removes that coloured die from the game. Nobody crosses anything off in that row again, including you.',
          'Lock too early and you cut your own scoring short. Lock too late and someone else takes it.',
        ],
      },
    ],
  },
  {
    id: 'game-end',
    title: 'How the game ends',
    body: [
      'The game ends the moment either of these happens.',
      {
        items: ['Any player marks a fourth penalty.', 'Two coloured rows are locked.'],
      },
      'Then add up each row, subtract 5 for each penalty, and the highest total wins.',
      'If two players tie, the one with fewer penalties wins. If they still tie, the one with the most numbers crossed off in a single row wins.',
    ],
  },
  {
    id: 'strategy',
    title: 'Strategy',
    body: [
      {
        items: [
          'Early on, favour the middle numbers 6, 7 and 8. They come up most often.',
          'Do not rush. A cross you regret blocks everything to its left.',
          'Watch which rows the other players are filling.',
          'Mid game, pick the rows you can realistically finish and push those.',
          'Late game, defend. Locking a row denies it to everyone else.',
          '2, 3, 11 and 12 are rare. Do not wait for them.',
          'Green and blue often score less than red and yellow because they run downwards from 12.',
          'Taking a penalty is sometimes better than crossing off a number that blocks your row.',
        ],
      },
    ],
  },
  {
    id: 'probability',
    title: 'Dice probability',
    body: [
      'Two white dice, 36 outcomes.',
      {
        items: [
          '7 comes up 6 ways out of 36.',
          '6 and 8 come up 5 ways each.',
          '5 and 9 come up 4 ways each.',
          '4 and 10 come up 3 ways each.',
          '3 and 11 come up 2 ways each.',
          '2 and 12 come up 1 way each.',
        ],
      },
      'So 6, 7 and 8 are the numbers to build around, and 2 and 12 are the ones to plan for rather than wait for.',
    ],
  },
  {
    id: 'cheat-sheet',
    title: 'Scoring cheat sheet',
    body: [
      {
        items: [
          'Cross off left to right only.',
          'You need 5 crosses in a row before you can lock it.',
          'The lock counts as an extra crossed number.',
          'Four penalties ends the game.',
          'Two locked rows ends the game.',
          'Each penalty costs 5 points.',
        ],
      },
    ],
  },
];
