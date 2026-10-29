-- A small idle habit, independent of the language model. Limit it to ordinary
-- resources so the companion does not indiscriminately grab valuables.
local Pickup = {}
local RADIUS = 6
local LEADER_DISTANCE = 10
local RETRY = 4
local ITEMS = {
    log = true, twigs = true, cutgrass = true, flint = true, rocks = true,
    nitre = true, goldnugget = true, charcoal = true, cutstone = true,
    pinecone = true, acorn = true, seeds = true, berries = true, carrot = true,
    petals = true, manure = true, poop = true,
}

function Pickup.Next(inst)
    local sei = inst.sei
    if sei == nil or sei.paused or sei.cmd ~= nil then return nil end
    if inst.sg ~= nil and inst.sg:HasStateTag("busy") then return nil end
    if inst.components.inventory == nil then return nil end
    local now = GetTime()
    if sei.pickupTry ~= nil and now < sei.pickupTry then return nil end
    sei.pickupTry = now + RETRY
    local x, y, z = inst.Transform:GetWorldPosition()
    local leader = sei.follow
    if leader ~= nil and leader:IsValid() then
        local lx, _, lz = leader.Transform:GetWorldPosition()
        if (x-lx)*(x-lx) + (z-lz)*(z-lz) > LEADER_DISTANCE * LEADER_DISTANCE then return nil end
    end
    local entities = TheSim:FindEntities(x, y, z, RADIUS, nil, { "INLIMBO", "NOCLICK", "CLASSIFIED", "FX", "fire" })
    local best, bestDist = nil, math.huge
    for _, item in ipairs(entities) do
        local invitem = item.components.inventoryitem
        if ITEMS[item.prefab] and item:IsValid() and invitem ~= nil and invitem.canbepickedup
            and invitem:GetGrandOwner() == nil and not item:HasTag("heavy")
            and inst.components.inventory:CanAcceptCount(item, 1) > 0 then
            local ix, _, iz = item.Transform:GetWorldPosition()
            local d = (x-ix)*(x-ix) + (z-iz)*(z-iz)
            if d < bestDist then best, bestDist = item, d end
        end
    end
    if best == nil then return nil end
    return BufferedAction(inst, best, ACTIONS.PICKUP)
end

return Pickup
