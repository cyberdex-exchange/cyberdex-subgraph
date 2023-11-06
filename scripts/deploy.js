/* eslint-disable @typescript-eslint/no-var-requires */
'use strict';

const fs = require('fs');
const path = require('path');
const { green, cyan, gray, greenBright } = require('chalk');
const program = require('commander');
const inquirer = require('inquirer');
const { execSync } = require('child_process');
const { print } = require('graphql');
const { mergeTypeDefs } = require('@graphql-tools/merge');
require('dotenv').config();

// env variables
const SATSUMA_DEPLOY_KEY = process.env.SATSUMA_DEPLOY_KEY;

// functions
const parseBoolean = (val) => {
  return val == 'false' ? false : val;
};

function exec(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

program
  .option('-u --update-synthetix [version]', 'Update the Synthetix package and contract ABIs to the given version')
  .option('-s --subgraph <names>', 'The subgraph to deployed')
  .option('-p --provider <name>', 'The subgraph to ')
  .option('-t --team <name>', 'The Graph team name')
  .option('-n --network <value>', 'Network used for this deploy')
  .option('-a --access-token <token>', 'The Graph access token')
  .option('-d, --deploy-decentralized [value]', 'Deploy to the decentralized network', parseBoolean)
  .option('-v, --version <value>', 'Version label for the deployment to the decentralized network')
  .option('--build-only', 'Skip deploy');

program.action(async () => {
  const MAIN_SUBGRAPH_EXCLUDE = [];
  const NETWORK_CHOICES = ['mainnet', 'goerli', 'optimism', 'optimism-goerli', 'base-testnet'];
  const SUBGRAPH_CHOICES = await fs.readdirSync(path.join(__dirname, '../subgraphs')).reduce((acc, val) => {
    if (val.endsWith('.js') && val !== 'main.js') {
      acc.push(val.slice(0, -3));
    }
    return acc;
  }, []);
  const OPTIONS = program.opts();

  if (OPTIONS.updateSynthetix) {
    console.log(cyan('Updating the Synthetix package and contract ABIs...'));
    await exec(`npm install synthetix@${OPTIONS.updateSynthetix == true ? 'latest' : OPTIONS.updateSynthetix}`);
    console.log(green('Successfully updated the Synthetix package for the most recent contracts.'));
    await exec('node scripts/helpers/prepare-abis.js');
    console.log(green('Successfully prepared the ABI files for subgraph generation.'));
  }

  const inquiries = [];

  if (!OPTIONS.subgraph) {
    inquiries.push({
      message:
        'Which subgraph would you like to deploy? ' +
        gray('You should only deploy subgraphs other than the main subgraph for development and testing.'),
      name: 'subgraph',
      type: 'list',
      default: 'main',
      choices: [{ name: 'Main Subgraph', value: 'main' }, new inquirer.Separator(), ...SUBGRAPH_CHOICES],
    });
  }

  if (!OPTIONS.provider) {
    inquiries.push({
      message: 'Which provider would you like to use for this deploy?',
      name: 'provider',
      type: 'list',
      default: 'hosted_subgraph',
      choices: [
        { name: 'Satsuma', value: 'satsuma' },
        { name: 'The Graph', value: 'hosted_service' },
      ],
    });
  }

  if (!OPTIONS.network) {
    inquiries.push({
      message: 'Which networks should be built (and deployed)?',
      name: 'network',
      type: 'list',
      default: 'All',
      choices: ['All', 'None', new inquirer.Separator(), ...NETWORK_CHOICES],
    });
  }

  if (!OPTIONS.team) {
    inquiries.push({
      message: 'What is your team name on The Graph?',
      name: 'team',
      default: 'synthetixio-team',
    });
  }

  if (!OPTIONS.version) {
    inquiries.push({
      message: 'What is the version label for this deploy?',
      name: 'version',
      default: '0.0.1-test',
    });
  }

  let settings = {
    ...(await inquirer.prompt(inquiries, OPTIONS)),
    ...OPTIONS,
  };

  if (settings.subgraph == 'main') {
    console.log('Generating the main subgraph...');

    // We merge using this strategy to avoid duplicates from the fragments
    let typesArray = [];
    for (let i = 0; i < SUBGRAPH_CHOICES.length; i++) {
      if (!MAIN_SUBGRAPH_EXCLUDE.includes(SUBGRAPH_CHOICES[i])) {
        typesArray.push(
          (await fs.readFileSync(path.join(__dirname, `../subgraphs/${SUBGRAPH_CHOICES[i]}.graphql`))).toString(),
        );
      }
    }
    const typeDefs = mergeTypeDefs(typesArray);

    // https://www.graphql-tools.com/docs/schema-merging#print-merged-typedefs
    const AUTOGEN_NOTICE = '""" THIS FILE IS AUTOMATICALLY GENERATED BY THE DEPLOY SCRIPT """\n\n ';
    const printedTypeDefs = print(typeDefs);
    fs.writeFileSync('subgraphs/main.graphql', AUTOGEN_NOTICE + printedTypeDefs);
    console.log(green('Successfully generated the main subgraph.'));
  }

  console.log(gray('Executing prebuild steps:'));

  console.log(cyan('Running The Graph’s codegen...'));
  for (let i = 0; i < SUBGRAPH_CHOICES.length; i++) {
    const subgraph = SUBGRAPH_CHOICES[i];
    await exec(
      `NETWORK=mainnet SUBGRAPH=${subgraph} ./node_modules/.bin/graph codegen ./subgraphs/${subgraph}.js -o ./generated/subgraphs/${subgraph}`,
    );
  }

  console.log(cyan('Creating contracts...'));
  await exec('node ./scripts/helpers/create-contracts');

  const networkPrefix = (network) => {
    return network + '-';
  };

  if (settings.network !== 'None') {
    if (settings.network == 'All') {
      for (let i = 0; i < NETWORK_CHOICES.length; i++) {
        const network = NETWORK_CHOICES[i];

        console.log(cyan(`Building subgraph for network ${network}...`));

        try {
          await exec(
            `NETWORK=${network} SUBGRAPH=${settings.subgraph} ./node_modules/.bin/graph build ./subgraphs/${settings.subgraph}.js -o ./build/${network}/subgraphs/${settings.subgraph}`,
          );
        } catch {
          process.exit(1);
        }

        if (!settings.buildOnly) {
          await exec(
            `START_BLOCK=${
              process.env.START_BLOCK || 0
            } NETWORK=${network} ./node_modules/.bin/graph deploy --node https://api.thegraph.com/deploy/ --ipfs https://api.thegraph.com/ipfs/ ${
              settings.team
            }/${networkPrefix(network)}${settings.subgraph} ./subgraphs/${settings.subgraph}.js`,
          );
          console.log(green(`Successfully deployed to ${network} on the hosted service.`));
        }
      }
    } else {
      console.log(cyan(`Building subgraph for network ${settings.network}...`));
      try {
        await exec(
          `NETWORK=${settings.network} SUBGRAPH=${settings.subgraph} ./node_modules/.bin/graph build ./subgraphs/${settings.subgraph}.js -o ./build/${settings.network}/subgraphs/${settings.subgraph}`,
        );
      } catch {
        process.exit(1);
      }

      if (!settings.buildOnly) {
        if (settings.provider === 'hosted_service') {
          await exec(
            `NETWORK=${
              settings.network
            } ./node_modules/.bin/graph deploy --node https://api.thegraph.com/deploy/ --ipfs https://api.thegraph.com/ipfs/ ${
              settings.team
            }/${networkPrefix(settings.network)}${settings.subgraph} ./subgraphs/${settings.subgraph}.js`,
          );
          console.log(green(`Successfully deployed to ${settings.network} on the hosted service.`));
        } else if (settings.provider === 'satsuma') {
          await exec(
            `NETWORK=${settings.network} ./node_modules/.bin/graph deploy ${networkPrefix(settings.network)}${
              settings.subgraph
            } --deploy-key ${SATSUMA_DEPLOY_KEY} --version-label ${
              settings.version
            } --node https://subgraphs.alchemy.com/api/subgraphs/deploy ./subgraphs/${settings.subgraph}.js`,
          );
          console.log(green(`Successfully deployed to ${settings.network} on Satsuma.`));
        }
      }
    }
  }

  console.log(greenBright('All operations completed successfully!'));
});

program.parse(process.argv);
