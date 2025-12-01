import { DataCache } from "../database/cache";
import { MachineStateTable } from "../database/table";
import { IdentityProviderClient } from "../external/idp";
import { SmartMachineClient } from "../external/smart-machine";
import { GetMachineRequestModel, HttpResponseCode, MachineResponseModel, RequestMachineRequestModel, RequestModel, StartMachineRequestModel } from "./model";
import { MachineStateDocument, MachineStatus } from "../database/schema";
/**
 * Handles API requests for machine operations.
 * This class is responsible for routing requests to the appropriate handlers
 * and managing the overall workflow of machine interactions.
 */
export class ApiHandler {
    private cache: DataCache<MachineStateDocument>;
    constructor() {
        this.cache = DataCache.getInstance<MachineStateDocument>();
    }

    /**
     * Validates an authentication token.
     * @param token The token to validate.
     * @throws An error if the token is invalid.
     */
    private checkToken(token: string) {
        const instance_of_IP = IdentityProviderClient.getInstance();
        const validity_of_token = instance_of_IP.validateToken(token);
        if(validity_of_token === true){
            return;
        }
        else{
            throw{statusCode:HttpResponseCode.UNAUTHORIZED, thrownMessage:"ERROR: checkToken implementation flagged as unauthorized\n"};
        }
    }

    /**
     * Handles a request to find and reserve an available machine at a specific location.
     * It finds an available machine, updates its status to AWAITING_DROPOFF,
     * assigns the job ID, and caches the updated machine state.
     * NOTE: The current implementation assumes a machine will be held for a certain period,
     * but there is no mechanism to release the hold if the user doesn't proceed.
     * @param request The request model containing location and job IDs.
     * @returns A response model with the status code and the reserved machine's state.
     */
    private handleRequestMachine(request: RequestMachineRequestModel): MachineResponseModel {
        // Your implementation here
        const requested_location_ID: string = request.locationId;
        const requested_job_ID: string = request.jobId;
        const table_instance = MachineStateTable.getInstance();
        const machines_at_location: MachineStateDocument[] = table_instance.listMachinesAtLocation(requested_location_ID);
        const number_of_machines_at_location = machines_at_location.length

        //do a quick check if there are no machines from the database
        if (number_of_machines_at_location === 0){
            return{statusCode:HttpResponseCode.NOT_FOUND,machine: undefined};
        }

        const available_machines_at_location = machines_at_location.filter((machine)=>machine.status === MachineStatus.AVAILABLE);
        const number_of_available_machines_at_locaiton = available_machines_at_location.length

        //another quick check if there are no available machines from the database for a more specific error... BAD_REQUEST in stead of NOT_FOUND
        if (number_of_available_machines_at_locaiton === 0){
            return{statusCode:HttpResponseCode.BAD_REQUEST,machine: undefined};
        }

        //we know we can do this because we did a check on length
        const first_available_machine = available_machines_at_location[0];
        const curr_machine_id = first_available_machine.machineId;


        /* these are the interfaces we need to call to update the machines attributes in the database

            public updateMachineStatus(machineId: string, status: MachineStatus) {
                MachineStateTable.dbAccesses++;
                this.consume(DATABASE_WRITE);
                const machine = this.machines.get(machineId);
                if (machine) {
                    machine.status = status;
                }
            }

            public updateMachineJobId(machineId: string, jobId: string) {
                MachineStateTable.dbAccesses++;
                this.consume(DATABASE_LAZY_WRITE);
                const machine = this.machines.get(machineId);
                if (machine) {
                    machine.currentJobId = jobId;
                }
            }

        */

        table_instance.updateMachineStatus(curr_machine_id, MachineStatus.AWAITING_DROPOFF);
        table_instance.updateMachineJobId(curr_machine_id, requested_job_ID );

        //make sure we pull the updated machine from the database to put in the cache
        const updated_machine = table_instance.getMachine(curr_machine_id);
        const curr_cache_instance = DataCache.getInstance<MachineStateDocument>();
        curr_cache_instance.put(curr_machine_id, updated_machine!);


        return {statusCode: HttpResponseCode.OK,machine: updated_machine};
    }

    /**
     * Retrieves the state of a specific machine.
     * It first checks the cache for the machine's data and, if not found, fetches it from the database.
     * @param request The request model containing the machine ID.
     * @returns A response model with the status code and the machine's state.
     */
    private handleGetMachine(request: GetMachineRequestModel): MachineResponseModel {
        const curr_machine_id = request.machineId;

        //check cache first!
        const curr_cache_instance = DataCache.getInstance<MachineStateDocument>();
        let curr_machine = curr_cache_instance.get(curr_machine_id);

        if(curr_machine === undefined){
            //gotta get it from table :/
            const curr_table_instance = MachineStateTable.getInstance();
            curr_machine = curr_table_instance.getMachine(curr_machine_id);

            if (curr_machine === undefined){
                //if we STILL can't find it, return appropriate NOT_FOUND error
                return {statusCode: HttpResponseCode.NOT_FOUND,machine: undefined};
            }
            //otherwise we can throw it in the cache if we got it from the table
            curr_cache_instance.put(curr_machine_id, curr_machine);
        }

        return{statusCode:HttpResponseCode.OK, machine:curr_machine};

    }

    /**
     * Starts the cycle of a machine that is awaiting drop-off.
     * It validates the machine's status, calls the external Smart Machine API to start the cycle,
     * and updates the machine's status to RUNNING.
     * @param request The request model containing the machine ID.
     * @returns A response model with the status code and the updated machine's state.
     */
    private handleStartMachine(request: StartMachineRequestModel): MachineResponseModel {
        const curr_machine_id = request.machineId;

        //gonna repeat same process from last method of trying cache then trying db
        const curr_cache_instance = DataCache.getInstance<MachineStateDocument>();
        let curr_machine = curr_cache_instance.get(curr_machine_id);
        const curr_table_instance = MachineStateTable.getInstance();
        
        if(curr_machine === undefined){
            curr_machine = curr_table_instance.getMachine(curr_machine_id);
            if (curr_machine === undefined){
                return {statusCode: HttpResponseCode.NOT_FOUND,machine: undefined};
            }
        }

        const curr_machine_status = curr_machine.status;
        if (curr_machine_status != MachineStatus.AWAITING_DROPOFF){
            return {statusCode: HttpResponseCode.BAD_REQUEST,machine: undefined};
        }

        const api_instance = SmartMachineClient.getInstance();
        api_instance.startCycle(curr_machine_id);

        curr_table_instance.updateMachineStatus(curr_machine_id, MachineStatus.RUNNING);
        const updated_machine = curr_table_instance.getMachine(curr_machine_id);
        curr_cache_instance.put(curr_machine_id, updated_machine!);

        return {statusCode: HttpResponseCode.OK,machine: updated_machine};
    }

    /**
     * The main entry point for handling all API requests.
     * It validates the token and routes the request to the appropriate private handler based on the method and path.
     * @param request The incoming request model.
     * @returns A response model from one of the specific handlers, or an error response.
     */
    public handle(request: RequestModel) {
        this.checkToken(request.token);

        if (request.method === 'POST' && request.path === '/machine/request') {
            return this.handleRequestMachine(request as RequestMachineRequestModel);
        }

        const getMachineMatch = request.path.match(/^\/machine\/([a-zA-Z0-9-]+)$/);
        if (request.method === 'GET' && getMachineMatch) {
            const machineId = getMachineMatch[1];
            const getRequest = { ...request, machineId } as GetMachineRequestModel;
            return this.handleGetMachine(getRequest);
        }

        const startMachineMatch = request.path.match(/^\/machine\/([a-zA-Z0-9-]+)\/start$/);
        if (request.method === 'POST' && startMachineMatch) { 
            const machineId = startMachineMatch[1];
            const startRequest = { ...request, machineId } as StartMachineRequestModel;
            return this.handleStartMachine(startRequest);
        }

        return { statusCode: HttpResponseCode.INTERNAL_SERVER_ERROR, machine: null };
    }
    
}