import { recover } from '../pipeline/recovery.mjs';

export async function controllerOperation(input,config,store,providers,runner) {
  const operation=input.operation || 'tick';
  if (operation==='tick') return runner.tick();
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
