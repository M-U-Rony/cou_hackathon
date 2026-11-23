import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MarketPicker } from './MarketPicker'

const options = ['Bogra Sadar', 'Comilla Sadar', 'Feni Sadar']

describe('MarketPicker', () => {
  it('shows a visible Bangla label and an accessible select', () => {
    render(<MarketPicker options={options} value="Comilla Sadar" onChange={() => {}} />)
    expect(screen.getByText('তুলনার বাজার')).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'তুলনার জেলা/বাজার' })).toBeInTheDocument()
  })

  it('hints that the select only drives the WFP monthly comparison', () => {
    render(<MarketPicker options={options} value="Comilla Sadar" onChange={() => {}} />)
    expect(screen.getByText('জেলার তুলনা: WFP মাসিক দর')).toBeVisible()
  })

  it('renders one Bangla option per key', () => {
    render(<MarketPicker options={options} value="Comilla Sadar" onChange={() => {}} />)
    const opts = screen.getAllByRole('option').map((o) => o.textContent)
    expect(opts).toEqual(['বগুড়া সদর', 'কুমিল্লা সদর', 'ফেনী সদর'])
  })

  it('selects the given value', () => {
    render(<MarketPicker options={options} value="Feni Sadar" onChange={() => {}} />)
    expect(screen.getByRole('combobox')).toHaveValue('Feni Sadar')
  })

  it('defaults to showing Comilla Sadar selected', () => {
    render(<MarketPicker options={options} value="Comilla Sadar" onChange={() => {}} />)
    expect(screen.getByRole('option', { name: 'কুমিল্লা সদর' })).toHaveProperty('selected', true)
  })

  it('calls onChange with the WFP key, not the Bangla label', async () => {
    const onChange = vi.fn()
    render(<MarketPicker options={options} value="Comilla Sadar" onChange={onChange} />)
    await userEvent.selectOptions(screen.getByRole('combobox'), 'Bogra Sadar')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('Bogra Sadar')
  })

  it('renders nothing when there are no options', () => {
    const { container } = render(<MarketPicker options={[]} value="" onChange={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
