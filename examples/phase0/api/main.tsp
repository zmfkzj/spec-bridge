import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;

@service(#{ title: "Job API" })
namespace JobApi;

model Job {
  id: string;
  owner?: string;
}

model ClaimRequest {
  workerId?: string;
}

@route("/jobs")
interface Jobs {
  @extension("x-specbridge-requirements", #["job-claim/exclusive-job-claim"])
  @post @route("{id}/claim") claimJob(@path id: string, @body body: ClaimRequest): Job;
}
