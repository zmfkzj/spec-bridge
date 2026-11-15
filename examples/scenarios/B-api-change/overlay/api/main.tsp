import "@typespec/http";
import "@typespec/openapi";

using Http;
using OpenAPI;

@service(#{ title: "Job API" })
namespace JobApi;

model Job {
  id: string;
  status: "queued" | "claimed" | "done";
  owner?: string;
  payload: string;
}

model SubmitJobRequest {
  payload: string;
  priority: int32;
}

model ClaimRequest {
  workerId?: string;
  @minValue(30) @maxValue(3600) leaseSeconds?: int32;
}

@error
model ConflictError {
  @statusCode _: 409;
  message: string;
}

@error
model NotFoundError {
  @statusCode _: 404;
  message: string;
}

@route("/jobs")
interface Jobs {
  @extension("x-specbridge-requirements", #["job-submission/job-submission"])
  @post submitJob(@body body: SubmitJobRequest): Job;

  @extension("x-specbridge-requirements", #["job-claim/exclusive-job-claim", "job-claim/claim-lease-bounds"])
  @post @route("{id}/claim") claimJob(@path id: string, @body body: ClaimRequest): Job | NotFoundError;

  @post @route("{id}/complete") completeJob(@path id: string): Job | NotFoundError;

  @get @route("{id}") getJob(@path id: string): Job | NotFoundError;
}
