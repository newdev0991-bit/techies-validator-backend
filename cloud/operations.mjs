import { recover } from '../pipeline/recovery.mjs';
import { importSearch } from './import-search.mjs';

export async function controllerOperation(input,config,store,providers,runner) {
  const operation=input.operation || 'tick';
  if (operation==='tick') return runner.tick();
  if (operation==='import-search-plan' || operation==='import-search-run') return importSearch(input,config,store,providers,runner);
  const commands={
    'recovery-plan':['recover-bounded-searches',[]],
    'recover-bounded-searches':['recover-bounded-searches',['--apply']],
    'preflight-recovery-plan':['recover-preflight',[]],
    'recover-preflight':['recover-preflight',['--apply']],
  };
  if (!Object.hasOwn(commands,operation)) throw new Error('INVALID_OPERATION');
  if (input.enabled===true) throw new Error('RECOVERY_REQUIRES_PROCESSING_OFF');
  const [command,args]=commands[operation];
  return recover(command,args,{...config,enabled:false},store,providers);
}
