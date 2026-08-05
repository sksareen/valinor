"""
HTTP routes for personal loop templates + guided sessions.
"""
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

router = APIRouter(tags=["loops"])

_NO_STORE = {"Cache-Control": "no-store"}


@router.get("/loops/templates")
async def list_loop_templates():
    from loop_templates import list_all_templates

    return JSONResponse(
        content={"templates": await list_all_templates()},
        headers=_NO_STORE,
    )


@router.get("/loops/templates/{loop_id}")
async def read_loop_template(loop_id: str):
    from loop_templates import get_template

    loop = await get_template(loop_id)
    if not loop:
        raise HTTPException(status_code=404, detail="Loop template not found")
    return loop


class CreateTemplateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    stages: List[str] = Field(..., min_length=2, max_length=12)
    description: str = Field(default="")
    default_query: str = Field(default="")
    color: Optional[str] = Field(default=None)
    slug: Optional[str] = Field(default=None)


@router.post("/loops/templates")
async def create_loop_template(body: CreateTemplateRequest):
    from loop_templates import create_custom_template

    try:
        created = await create_custom_template(
            name=body.name,
            stages=body.stages,
            description=body.description,
            default_query=body.default_query,
            color=body.color,
            slug=body.slug,
        )
        return JSONResponse(content=created, headers=_NO_STORE)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.delete("/loops/templates/{loop_id}")
async def delete_loop_template(loop_id: str):
    from loop_templates import delete_custom_template

    try:
        ok = await delete_custom_template(loop_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not ok:
        raise HTTPException(status_code=404, detail="Custom loop not found")
    return {"ok": True, "id": loop_id}


class StartGuidedRequest(BaseModel):
    prompt: str = Field(default="")


class GuidedRespondRequest(BaseModel):
    message: str = Field(..., min_length=1)


@router.post("/guided-runs/laundry")
async def start_guided_laundry(body: StartGuidedRequest):
    from guided_laundry import start_laundry

    try:
        return await start_laundry(body.prompt or "Help me do one load of laundry.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/guided-runs/laundry/{run_id}")
async def get_guided_laundry(run_id: str):
    from guided_laundry import get_laundry

    run = await get_laundry(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Guided laundry run not found")
    return run


@router.post("/guided-runs/laundry/{run_id}/respond")
async def respond_guided_laundry(run_id: str, body: GuidedRespondRequest):
    from guided_laundry import respond_laundry

    try:
        return await respond_laundry(run_id, body.message)
    except KeyError:
        raise HTTPException(status_code=404, detail="Guided laundry run not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/guided-runs/gym")
async def start_guided_gym(body: StartGuidedRequest):
    from guided_gym import start_gym

    try:
        return await start_gym(
            body.prompt
            or "Gym loop — I need to decide what to do and I can leave in about 20 minutes."
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/guided-runs/gym/{run_id}")
async def get_guided_gym(run_id: str):
    from guided_gym import get_gym

    run = await get_gym(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Guided gym run not found")
    return run


@router.post("/guided-runs/gym/{run_id}/respond")
async def respond_guided_gym(run_id: str, body: GuidedRespondRequest):
    from guided_gym import respond_gym

    try:
        return await respond_gym(run_id, body.message)
    except KeyError:
        raise HTTPException(status_code=404, detail="Guided gym run not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/guided-runs/japa")
async def start_guided_japa(body: StartGuidedRequest):
    from guided_japa import start_japa

    try:
        return await start_japa(body.prompt or "Log my japa / meditation session.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/guided-runs/japa/{run_id}")
async def get_guided_japa(run_id: str):
    from guided_japa import get_japa

    run = await get_japa(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Guided japa run not found")
    return run


@router.post("/guided-runs/japa/{run_id}/respond")
async def respond_guided_japa(run_id: str, body: GuidedRespondRequest):
    from guided_japa import respond_japa

    try:
        return await respond_japa(run_id, body.message)
    except KeyError:
        raise HTTPException(status_code=404, detail="Guided japa run not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


# Generic guided_simple routes (builtins like sleep/walk + user-created templates)
@router.post("/guided-runs/{loop_id}")
async def start_guided_simple(loop_id: str, body: StartGuidedRequest):
    if loop_id in ("laundry", "gym", "japa", "exercise"):
        raise HTTPException(status_code=404, detail="Use the dedicated route for this loop")
    from guided_simple import start_simple
    from loop_templates import resolve_defn

    if not await resolve_defn(loop_id):
        raise HTTPException(status_code=404, detail=f"Unknown loop: {loop_id}")
    try:
        return await start_simple(loop_id, body.prompt or f"Start {loop_id}.")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/guided-runs/{loop_id}/{run_id}")
async def get_guided_simple(loop_id: str, run_id: str):
    if loop_id in ("laundry", "gym", "japa", "exercise"):
        raise HTTPException(status_code=404, detail="Use the dedicated route for this loop")
    from guided_simple import get_simple

    run = await get_simple(loop_id, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Guided run not found")
    return run


@router.post("/guided-runs/{loop_id}/{run_id}/respond")
async def respond_guided_simple(loop_id: str, run_id: str, body: GuidedRespondRequest):
    if loop_id in ("laundry", "gym", "japa", "exercise"):
        raise HTTPException(status_code=404, detail="Use the dedicated route for this loop")
    from guided_simple import respond_simple

    try:
        return await respond_simple(loop_id, run_id, body.message)
    except KeyError:
        raise HTTPException(status_code=404, detail="Guided run not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
