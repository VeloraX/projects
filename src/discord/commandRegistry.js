const SUBCOMMAND_OPTION = 1;
const SUBCOMMAND_GROUP_OPTION = 2;
const STRING_OPTION = 3;
const INTEGER_OPTION = 4;
const BOOLEAN_OPTION = 5;

export const TRACKER_COMMAND = 'tracker';
export const PROJECTS_COMMAND = 'projects';
export const LEGACY_TRACKED_PROJECT_VIEW_COMMAND = 'tracked-project-view';

export const trackerCommandRegistry = Object.freeze([
  createTrackerRootCommand(TRACKER_COMMAND),
  createTrackerRootCommand(PROJECTS_COMMAND)
]);

function createTrackerRootCommand(name) {
  return {
    name,
    description: 'View and configure tracked GitHub Project boards from Discord.',
    options: [
      {
        type: SUBCOMMAND_OPTION,
        name: 'board',
        description: 'Show the active tracked GitHub Project board.',
        options: [
          createStatusOption(),
          {
            type: STRING_OPTION,
            name: 'project',
            description: 'Optional saved tracker project key to open instead of the active project.',
            required: false
          }
        ]
      },
      {
        type: SUBCOMMAND_GROUP_OPTION,
        name: 'settings',
        description: 'Manage saved GitHub Project settings for this Discord guild.',
        options: [
          {
            type: SUBCOMMAND_OPTION,
            name: 'show',
            description: 'Show the active tracked project and saved project list.'
          },
          {
            type: SUBCOMMAND_OPTION,
            name: 'set',
            description: 'Save or update a tracked GitHub Project for this Discord guild.',
            options: [
              {
                type: STRING_OPTION,
                name: 'key',
                description: 'Short key used to reference this tracked project later.',
                required: true
              },
              {
                type: STRING_OPTION,
                name: 'org',
                description: 'GitHub organization login that owns the project.',
                required: true
              },
              {
                type: INTEGER_OPTION,
                name: 'project_number',
                description: 'GitHub Project number to track.',
                required: true
              },
              {
                type: STRING_OPTION,
                name: 'label',
                description: 'Optional display label for the saved project.',
                required: false
              },
              {
                type: BOOLEAN_OPTION,
                name: 'make_active',
                description: 'Set this saved project as the active project immediately.',
                required: false
              }
            ]
          },
          {
            type: SUBCOMMAND_OPTION,
            name: 'use',
            description: 'Switch the active tracked project for this Discord guild.',
            options: [
              {
                type: STRING_OPTION,
                name: 'key',
                description: 'Saved tracker project key to activate.',
                required: true
              }
            ]
          }
        ]
      }
    ]
  };
}

function createStatusOption() {
  return {
    type: STRING_OPTION,
    name: 'status',
    description: 'Optional status filter for returned items.',
    required: false,
    choices: [
      {
        name: 'All',
        value: 'all'
      },
      {
        name: 'In progress',
        value: 'in_progress'
      },
      {
        name: 'Todo',
        value: 'todo'
      },
      {
        name: 'Done',
        value: 'done'
      }
    ]
  };
}
